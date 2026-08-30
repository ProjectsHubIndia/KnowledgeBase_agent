import asyncio
import mimetypes
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import APIError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import router as admin_router
from app.agent import DEFAULT_PERSONA, DEFAULT_SUGGESTIONS, answer_question
from app.auth import CurrentUser, agent_access, bearer_token, current_user
from app.auth import router as auth_router
from app.config import settings
from app.db import Agent, SessionLocal, User, get_session, init_db
from app.extract import extract_invoice
from app.parsing import is_supported, parse_to_markdown
from app.schemas import (
    AgentStats,
    AgentSuggestions,
    AskRequest,
    AskResponse,
    IngestResponse,
    MessageOut,
    SessionResponse,
    SessionSummary,
)
from app.security import decode_token, hash_password
from app.sessions import (
    append_turn,
    create_session,
    delete_session,
    list_sessions,
    load_history,
    load_transcript,
    session_exists,
)
from app.store import AgentStore, migrate_legacy_root

DEFAULT_AGENT_NAME = "Invoice Analyst"
DEFAULT_AGENT_SLUG = "invoice-analyst"

# Public paths — the SPA shell, its assets, and login itself must load before
# the caller has a token.
PUBLIC_PATHS = {"/", "/admin", "/health", "/auth/login"}


async def bootstrap() -> None:
    """First-run setup: seed the admin account and the default agent, and move
    any pre-multi-agent invoices into that agent's directory."""
    async with SessionLocal() as session:
        if not await session.scalar(select(User.id).limit(1)):
            session.add(
                User(
                    username=settings.auth_username,
                    password_hash=hash_password(settings.auth_password),
                    role="admin",
                )
            )
            await session.commit()

        if not await session.scalar(select(Agent.id).limit(1)):
            session.add(
                Agent(
                    slug=DEFAULT_AGENT_SLUG,
                    name=DEFAULT_AGENT_NAME,
                    description="Invoice analytics and finance document Q&A.",
                    system_prompt=DEFAULT_PERSONA,
                )
            )
            await session.commit()
            # Adopt data that predates multi-agent support.
            await run_in_threadpool(migrate_legacy_root, DEFAULT_AGENT_SLUG)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await bootstrap()
    yield


app = FastAPI(title="invoice-agent", version="0.2.0", lifespan=lifespan)


@app.middleware("http")
async def no_cache_frontend(request: Request, call_next):
    """Stop the browser caching SPA assets, so edits show up on refresh."""
    response = await call_next(request)
    path = request.url.path
    if path in ("/", "/admin") or path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.middleware("http")
async def require_auth(request: Request, call_next):
    """Verify the JWT on every non-public route and attach the caller.

    The token arrives either as an ``Authorization: Bearer`` header (added by the
    frontend's fetch wrapper) or as the ``fa_auth`` cookie — the cookie path is
    what lets browser-native requests that cannot carry a custom header (iframe
    and img `src`, download links like an invoice's /original) authenticate.
    """
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith("/static"):
        return await call_next(request)

    claims = decode_token(bearer_token(request) or "")
    if not claims:
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    request.state.user = CurrentUser(
        id=claims.get("sub", ""),
        username=claims.get("username", ""),
        role=claims.get("role", "user"),
    )
    return await call_next(request)


@app.exception_handler(APIError)
async def llm_error_handler(request: Request, exc: APIError) -> JSONResponse:
    """Surface LLM/provider errors as JSON so the frontend never sees a raw 500."""
    return JSONResponse(
        status_code=503,
        content={"detail": "The language model request failed. Please try again."},
    )


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


app.include_router(auth_router)
app.include_router(admin_router)


# ---------------------------------------------------------------------------
# Everything below is scoped to ONE agent: its own invoices, documents and
# conversations. `agent_access` resolves {agent_id} and refuses agents the
# caller was not granted.
# ---------------------------------------------------------------------------

agents = APIRouter(prefix="/agents/{agent_id}", tags=["agent"])


def store_for(agent: Agent = Depends(agent_access)) -> AgentStore:
    return AgentStore(agent.slug)


@agents.get("/stats", response_model=AgentStats)
async def agent_stats(store: AgentStore = Depends(store_for)) -> AgentStats:
    """Invoice/document counts for the switcher. Deliberately its own route,
    fetched lazily for the selected agent only — computing this for every
    granted agent up front would mean parsing every file on disk on login."""
    return AgentStats(
        invoices=len(store.list_invoices()),
        documents=len(store.list_documents()),
    )


@agents.get("/suggestions", response_model=AgentSuggestions)
async def agent_suggestions(agent: Agent = Depends(agent_access)) -> AgentSuggestions:
    """Onboarding chips for an empty thread — the agent's own list if the
    admin set one, else the built-in finance defaults."""
    if agent.suggestions:
        questions = [q.strip() for q in agent.suggestions.splitlines() if q.strip()]
        if questions:
            return AgentSuggestions(questions=questions)
    return AgentSuggestions(questions=DEFAULT_SUGGESTIONS)


@agents.post("/ingest/file", response_model=IngestResponse)
async def ingest_file(
    file: UploadFile = File(...),
    on_duplicate: str = Form("ask"),  # ask | replace | keep_both
    store: AgentStore = Depends(store_for),
) -> IngestResponse:
    """Upload one invoice (PDF/image/DOCX/XLSX/…) → MarkItDown → LLM extraction →
    stored as a structured markdown invoice in this agent's directory.

    If an invoice with the same number AND seller already exists, we do NOT
    silently overwrite or duplicate: with on_duplicate="ask" (default) we return
    409 with the existing invoice's details so the user can choose to replace it
    or keep both. on_duplicate="replace" overwrites; "keep_both" stores a copy.
    """
    filename = file.filename or "invoice"
    if not is_supported(filename):
        raise HTTPException(status_code=415, detail=f"Unsupported file: {filename}")
    data = await file.read()
    markdown = await run_in_threadpool(parse_to_markdown, filename, data)
    if not markdown:
        raise HTTPException(status_code=422, detail="No extractable text in file")

    fields, body = await extract_invoice(filename, markdown)

    # Non-invoice finance documents go to the document store (read for Q&A).
    if fields.get("document_type") != "invoice":
        title = fields.get("document_title") or filename
        doc_name = store.save_document(title, body, filename, data)
        return IngestResponse(name=doc_name, kind="document", title=title)

    existing = store.find_existing(fields.get("invoice_no"), fields.get("seller_name"))
    if existing and on_duplicate == "ask":
        raise HTTPException(
            status_code=409,
            detail={
                "message": "An invoice with the same number and seller already exists.",
                "existing_name": existing,
                "invoice_no": fields.get("invoice_no"),
                "seller_name": fields.get("seller_name"),
                "total_amount": fields.get("total_amount"),
            },
        )

    name = store.save_invoice(
        fields, body, name=existing if on_duplicate == "replace" else None
    )
    store.save_original(name, filename, data)  # keep the original for preview
    return IngestResponse(
        name=name,
        kind="invoice",
        invoice_no=fields.get("invoice_no"),
        total_amount=fields.get("total_amount"),
        tax_amount=fields.get("tax_amount"),
        currency=fields.get("currency"),
    )


@agents.post("/ingest/files")
async def ingest_files(
    files: list[UploadFile] = File(...),
    on_duplicate: str = Form("skip"),  # skip | replace | keep_both
    store: AgentStore = Depends(store_for),
) -> dict:
    """Bulk upload: extract many invoices concurrently (each is one LLM call,
    bounded by settings.bulk_concurrency). Duplicates are handled by the batch
    policy (default skip) since we can't prompt per-file. Returns a per-file
    result list plus a summary."""
    sem = asyncio.Semaphore(settings.bulk_concurrency)
    write_lock = asyncio.Lock()  # serialize the find-existing + write step
    loop = asyncio.get_running_loop()
    workers = min(settings.bulk_concurrency, len(files))

    async def handle(file: UploadFile, pool: ProcessPoolExecutor) -> dict:
        fn = file.filename or "invoice"
        if not is_supported(fn):
            return {"filename": fn, "status": "error", "detail": "unsupported type"}
        data = await file.read()
        try:
            # PDF parsing is CPU-bound (GIL-locked) — run it across processes so
            # files parse in true parallel. LLM extraction is async-concurrent.
            markdown = await loop.run_in_executor(pool, parse_to_markdown, fn, data)
            if not markdown:
                return {"filename": fn, "status": "error", "detail": "no text"}
            async with sem:
                fields, body = await extract_invoice(fn, markdown)
        except Exception as exc:  # noqa: BLE001 - report, don't fail the batch
            return {"filename": fn, "status": "error", "detail": str(exc)[:140]}
        async with write_lock:  # fast, serialized to avoid duplicate races
            if fields.get("document_type") != "invoice":
                title = fields.get("document_title") or fn
                doc_name = store.save_document(title, body, fn, data)
                return {
                    "filename": fn,
                    "status": "stored",
                    "kind": "document",
                    "name": doc_name,
                    "title": title,
                }
            existing = store.find_existing(
                fields.get("invoice_no"), fields.get("seller_name")
            )
            if existing and on_duplicate == "skip":
                return {
                    "filename": fn,
                    "status": "duplicate",
                    "invoice_no": fields.get("invoice_no"),
                }
            name = store.save_invoice(
                fields, body, name=existing if on_duplicate == "replace" else None
            )
            store.save_original(name, fn, data)  # keep the original for preview
        return {
            "filename": fn,
            "status": "stored",
            "kind": "invoice",
            "name": name,
            "invoice_no": fields.get("invoice_no"),
            "total_amount": fields.get("total_amount"),
        }

    with ProcessPoolExecutor(max_workers=workers) as pool:
        results = await asyncio.gather(*(handle(f, pool) for f in files))
    summary = {
        "stored": sum(r["status"] == "stored" for r in results),
        "duplicates": sum(r["status"] == "duplicate" for r in results),
        "errors": sum(r["status"] == "error" for r in results),
    }
    return {"summary": summary, "results": results}


@agents.get("/invoices")
async def invoices_list(store: AgentStore = Depends(store_for)) -> list[dict]:
    """Structured rows for every invoice stored against this agent."""
    return store.list_invoices()


@agents.get("/invoices/{name}")
async def invoice_detail(name: str, store: AgentStore = Depends(store_for)) -> dict:
    content = store.read_invoice(name)
    if content is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return {"name": name, "content": content}


@agents.api_route("/invoices/{name}/original", methods=["GET", "HEAD"])
async def invoice_original(name: str, store: AgentStore = Depends(store_for)):
    """Serve the original uploaded document (PDF/image/…) for inline preview.
    HEAD is supported so the UI can cheaply check if an original exists."""
    path = store.original_path(name)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Original file not available")
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media, content_disposition_type="inline")


@agents.delete("/invoices/{name}", status_code=204)
async def invoice_delete(name: str, store: AgentStore = Depends(store_for)) -> None:
    if not store.delete_invoice(name):
        raise HTTPException(status_code=404, detail="Invoice not found")


# ---------- Finance documents (non-invoice) ----------
@agents.get("/documents")
async def documents_list(store: AgentStore = Depends(store_for)) -> list[dict]:
    return store.list_documents()


@agents.get("/documents/{name}")
async def document_detail(name: str, store: AgentStore = Depends(store_for)) -> dict:
    content = store.read_document(name)
    if content is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"name": name, "content": content}


@agents.api_route("/documents/{name}/original", methods=["GET", "HEAD"])
async def document_original(name: str, store: AgentStore = Depends(store_for)):
    path = store.doc_original_path(name)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Original file not available")
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media, content_disposition_type="inline")


@agents.delete("/documents/{name}", status_code=204)
async def document_delete(name: str, store: AgentStore = Depends(store_for)) -> None:
    if not store.delete_document(name):
        raise HTTPException(status_code=404, detail="Document not found")


# ---------- Conversations ----------
@agents.get("/sessions", response_model=list[SessionSummary])
async def sessions_list(
    agent: Agent = Depends(agent_access),
    user: CurrentUser = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> list[SessionSummary]:
    return [
        SessionSummary(**s) for s in await list_sessions(session, user.id, agent.id)
    ]


@agents.post("/sessions", response_model=SessionResponse)
async def new_session(
    agent: Agent = Depends(agent_access),
    user: CurrentUser = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> SessionResponse:
    return SessionResponse(
        session_id=await create_session(session, user.id, agent.id)
    )


@agents.delete("/sessions/{session_id}", status_code=204)
async def remove_session(
    session_id: str,
    agent: Agent = Depends(agent_access),
    user: CurrentUser = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await session_exists(session, session_id, user.id, agent.id):
        raise HTTPException(status_code=404, detail="Unknown session")
    await delete_session(session, session_id)


@agents.get("/sessions/{session_id}/messages", response_model=list[MessageOut])
async def session_messages(
    session_id: str,
    agent: Agent = Depends(agent_access),
    user: CurrentUser = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> list[MessageOut]:
    if not await session_exists(session, session_id, user.id, agent.id):
        raise HTTPException(status_code=404, detail="Unknown session")
    return [MessageOut(**m) for m in await load_transcript(session, session_id)]


@agents.post("/ask", response_model=AskResponse)
async def ask(
    req: AskRequest,
    agent: Agent = Depends(agent_access),
    store: AgentStore = Depends(store_for),
    user: CurrentUser = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> AskResponse:
    if req.session_id:
        if not await session_exists(session, req.session_id, user.id, agent.id):
            raise HTTPException(status_code=404, detail="Unknown session")
        session_id = req.session_id
    else:
        session_id = await create_session(session, user.id, agent.id)

    history = await load_history(session, session_id)
    result = await answer_question(
        req.question,
        store=store,
        persona=agent.system_prompt,
        history=history,
    )
    meta = {
        "chart": result.chart.model_dump() if result.chart else None,
        "sources": result.sources,
        "aggregated": result.aggregated,
        "doc_sources": result.doc_sources,
    }
    await append_turn(session, session_id, req.question, result.answer, meta=meta)
    result.session_id = session_id
    return result


app.include_router(agents)


# ---------- Frontend (served last so API routes take precedence) ----------
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/admin", include_in_schema=False)
async def admin_page() -> FileResponse:
    """The admin console shell. It is public like index.html — the page itself
    only renders after its JS logs in and confirms the caller is an admin, and
    every /admin/* API call behind it is guarded server-side."""
    return FileResponse(WEB_DIR / "admin.html")
