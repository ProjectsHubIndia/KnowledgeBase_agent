import asyncio
import base64
import mimetypes
import secrets
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from openai import APIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import answer_question
from app.config import settings
from app.db import get_session, init_db
from app.extract import extract_invoice
from app.parsing import is_supported, parse_to_markdown
from app.schemas import (
    AskRequest,
    AskResponse,
    IngestResponse,
    MessageOut,
    SessionResponse,
    SessionSummary,
)
from app.sessions import (
    append_turn,
    create_session,
    delete_session,
    list_sessions,
    load_history,
    load_transcript,
    session_exists,
)
from app.store import (
    delete_document,
    delete_invoice,
    doc_original_path,
    find_existing,
    list_documents,
    list_invoices,
    original_path,
    read_document,
    read_invoice,
    save_document,
    save_invoice,
    save_original,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="invoice-agent", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def no_cache_frontend(request: Request, call_next):
    """Stop the browser caching SPA assets, so edits show up on refresh."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.middleware("http")
async def require_auth(request: Request, call_next):
    """Guard every route except the SPA shell with the shared login.

    index.html and /static stay public so the login form itself can load;
    the JS attaches a Basic-auth header (from the custom login form, not the
    native browser prompt) to every API call it makes.
    """
    path = request.url.path
    if path == "/" or path.startswith("/static"):
        return await call_next(request)

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Basic "):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    try:
        username, _, password = base64.b64decode(auth[6:]).decode().partition(":")
    except Exception:
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)

    valid = secrets.compare_digest(
        username, settings.auth_username
    ) and secrets.compare_digest(password, settings.auth_password)
    if not valid:
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
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


@app.post("/ingest/file", response_model=IngestResponse)
async def ingest_file(
    file: UploadFile = File(...),
    on_duplicate: str = Form("ask"),  # ask | replace | keep_both
) -> IngestResponse:
    """Upload one invoice (PDF/image/DOCX/XLSX/…) → MarkItDown → LLM extraction →
    stored as a structured markdown invoice.

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
        doc_name = save_document(title, body, filename, data)
        return IngestResponse(name=doc_name, kind="document", title=title)

    existing = find_existing(fields.get("invoice_no"), fields.get("seller_name"))
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

    name = save_invoice(
        fields, body, name=existing if on_duplicate == "replace" else None
    )
    save_original(name, filename, data)  # keep the original for preview
    return IngestResponse(
        name=name,
        kind="invoice",
        invoice_no=fields.get("invoice_no"),
        total_amount=fields.get("total_amount"),
        tax_amount=fields.get("tax_amount"),
        currency=fields.get("currency"),
    )


@app.post("/ingest/files")
async def ingest_files(
    files: list[UploadFile] = File(...),
    on_duplicate: str = Form("skip"),  # skip | replace | keep_both
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
                doc_name = save_document(title, body, fn, data)
                return {
                    "filename": fn,
                    "status": "stored",
                    "kind": "document",
                    "name": doc_name,
                    "title": title,
                }
            existing = find_existing(
                fields.get("invoice_no"), fields.get("seller_name")
            )
            if existing and on_duplicate == "skip":
                return {
                    "filename": fn,
                    "status": "duplicate",
                    "invoice_no": fields.get("invoice_no"),
                }
            name = save_invoice(
                fields, body, name=existing if on_duplicate == "replace" else None
            )
            save_original(name, fn, data)  # keep the original for preview
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


@app.get("/invoices")
async def invoices_list() -> list[dict]:
    """Structured rows for every stored invoice."""
    return list_invoices()


@app.get("/invoices/{name}")
async def invoice_detail(name: str) -> dict:
    content = read_invoice(name)
    if content is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    return {"name": name, "content": content}


@app.api_route("/invoices/{name}/original", methods=["GET", "HEAD"])
async def invoice_original(name: str):
    """Serve the original uploaded document (PDF/image/…) for inline preview.
    HEAD is supported so the UI can cheaply check if an original exists."""
    path = original_path(name)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Original file not available")
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media, content_disposition_type="inline")


@app.delete("/invoices/{name}", status_code=204)
async def invoice_delete(name: str) -> None:
    if not delete_invoice(name):
        raise HTTPException(status_code=404, detail="Invoice not found")


# ---------- Finance documents (non-invoice) ----------
@app.get("/documents")
async def documents_list() -> list[dict]:
    return list_documents()


@app.get("/documents/{name}")
async def document_detail(name: str) -> dict:
    content = read_document(name)
    if content is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"name": name, "content": content}


@app.api_route("/documents/{name}/original", methods=["GET", "HEAD"])
async def document_original(name: str):
    path = doc_original_path(name)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Original file not available")
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media, content_disposition_type="inline")


@app.delete("/documents/{name}", status_code=204)
async def document_delete(name: str) -> None:
    if not delete_document(name):
        raise HTTPException(status_code=404, detail="Document not found")


@app.get("/sessions", response_model=list[SessionSummary])
async def sessions_list(
    session: AsyncSession = Depends(get_session),
) -> list[SessionSummary]:
    return [SessionSummary(**s) for s in await list_sessions(session)]


@app.post("/sessions", response_model=SessionResponse)
async def new_session(
    session: AsyncSession = Depends(get_session),
) -> SessionResponse:
    return SessionResponse(session_id=await create_session(session))


@app.delete("/sessions/{session_id}", status_code=204)
async def remove_session(
    session_id: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    if not await delete_session(session, session_id):
        raise HTTPException(status_code=404, detail="Unknown session")


@app.get("/sessions/{session_id}/messages", response_model=list[MessageOut])
async def session_messages(
    session_id: str,
    session: AsyncSession = Depends(get_session),
) -> list[MessageOut]:
    if not await session_exists(session, session_id):
        raise HTTPException(status_code=404, detail="Unknown session")
    return [MessageOut(**m) for m in await load_transcript(session, session_id)]


@app.post("/ask", response_model=AskResponse)
async def ask(
    req: AskRequest,
    session: AsyncSession = Depends(get_session),
) -> AskResponse:
    if req.session_id:
        if not await session_exists(session, req.session_id):
            raise HTTPException(status_code=404, detail="Unknown session")
        session_id = req.session_id
    else:
        session_id = await create_session(session)

    history = await load_history(session, session_id)
    result = await answer_question(req.question, history=history)
    meta = {
        "chart": result.chart.model_dump() if result.chart else None,
        "sources": result.sources,
        "aggregated": result.aggregated,
        "doc_sources": result.doc_sources,
    }
    await append_turn(session, session_id, req.question, result.answer, meta=meta)
    result.session_id = session_id
    return result


# ---------- Frontend (served last so API routes take precedence) ----------
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")
