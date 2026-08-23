import json

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import ChatSession, Message


async def list_sessions(
    session: AsyncSession, user_id: str, agent_id: str
) -> list[dict]:
    """The caller's conversations with ONE agent that have at least one message,
    newest activity first, each with a title (first user message) and message
    count. Scoped to the owner so users never see each other's chats."""
    # Per-session aggregates: message count and most-recent message time.
    agg = (
        select(
            Message.session_id.label("sid"),
            func.count(Message.id).label("n"),
            func.max(Message.created_at).label("last"),
        )
        .group_by(Message.session_id)
        .subquery()
    )
    rows = (
        await session.execute(
            select(agg.c.sid, agg.c.n, agg.c.last)
            .join(ChatSession, ChatSession.id == agg.c.sid)
            .where(
                ChatSession.user_id == user_id,
                ChatSession.agent_id == agent_id,
            )
            .order_by(agg.c.last.desc())
        )
    ).all()

    summaries: list[dict] = []
    for sid, n, last in rows:
        title = await session.scalar(
            select(Message.content)
            .where(Message.session_id == sid, Message.role == "user")
            .order_by(Message.id.asc())
            .limit(1)
        )
        summaries.append(
            {
                "session_id": sid,
                "title": (title or "New conversation").strip(),
                "message_count": n,
                "last_active": last.isoformat() if last else None,
            }
        )
    return summaries


async def create_session(
    session: AsyncSession, user_id: str, agent_id: str
) -> str:
    chat = ChatSession(user_id=user_id, agent_id=agent_id)
    session.add(chat)
    await session.commit()
    return chat.id


async def delete_session(session: AsyncSession, session_id: str) -> bool:
    """Delete a session and its messages. Returns False if it didn't exist."""
    existed = await session_exists(session, session_id)
    if existed:
        await session.execute(
            delete(Message).where(Message.session_id == session_id)
        )
        await session.execute(
            delete(ChatSession).where(ChatSession.id == session_id)
        )
        await session.commit()
    return existed


async def session_exists(
    session: AsyncSession,
    session_id: str,
    user_id: str | None = None,
    agent_id: str | None = None,
) -> bool:
    """Whether the session exists — and, when owner/agent are given, that it
    belongs to that user and that agent. Callers pass both so a session id
    guessed from another account is indistinguishable from a missing one."""
    stmt = select(ChatSession.id).where(ChatSession.id == session_id)
    if user_id is not None:
        stmt = stmt.where(ChatSession.user_id == user_id)
    if agent_id is not None:
        stmt = stmt.where(ChatSession.agent_id == agent_id)
    return (await session.scalar(stmt)) is not None


async def load_history(session: AsyncSession, session_id: str) -> list[dict]:
    """Prior turns as LLM messages ({role, content} only — no meta), oldest
    first, capped to the most recent N turns to keep the prompt bounded."""
    stmt = (
        select(Message)
        .where(Message.session_id == session_id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(settings.history_turns * 2)
    )
    rows = list((await session.execute(stmt)).scalars())
    rows.reverse()
    return [{"role": m.role, "content": m.content} for m in rows]


async def load_transcript(session: AsyncSession, session_id: str) -> list[dict]:
    """Full conversation for the UI, oldest first — includes each assistant
    turn's chart/sources so the thread re-renders completely on reload."""
    rows = list(
        (
            await session.execute(
                select(Message)
                .where(Message.session_id == session_id)
                .order_by(Message.id.asc())
            )
        ).scalars()
    )
    out: list[dict] = []
    for m in rows:
        meta = json.loads(m.meta) if m.meta else {}
        out.append(
            {
                "role": m.role,
                "content": m.content,
                "chart": meta.get("chart"),
                "sources": meta.get("sources") or [],
                "aggregated": meta.get("aggregated") or [],
                "doc_sources": meta.get("doc_sources") or [],
            }
        )
    return out


async def append_turn(
    session: AsyncSession,
    session_id: str,
    question: str,
    answer: str,
    meta: dict | None = None,
) -> None:
    """Persist a user/assistant turn. `meta` (chart spec + sources) is stored on
    the assistant message so the turn re-renders on reload."""
    session.add_all(
        [
            Message(session_id=session_id, role="user", content=question),
            Message(
                session_id=session_id,
                role="assistant",
                content=answer,
                meta=json.dumps(meta) if meta else None,
            ),
        ]
    )
    await session.commit()
