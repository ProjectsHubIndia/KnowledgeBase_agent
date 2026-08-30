"""Admin console API: manage agents (name + system prompt), user accounts, and
which agents each user may use.

Agents deliberately have no tool configuration — every agent gets the same fixed
toolset from app.agent; the only thing an admin shapes is the prompt.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import DEFAULT_PERSONA, TOOL_CONTRACT
from app.auth import CurrentUser, require_admin
from app.db import Agent, ChatSession, User, UserAgent, get_session
from app.schemas import (
    AgentCreate,
    AgentOut,
    AgentUpdate,
    GrantsUpdate,
    UserCreate,
    UserOut,
    UserUpdate,
)
from app.security import hash_password
from app.store import AgentStore, slugify

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


async def _unique_slug(session: AsyncSession, name: str) -> str:
    """A slug not yet taken by another agent — it names the data directory."""
    base = slugify(name)
    slug, n = base, 2
    while await session.scalar(select(Agent.id).where(Agent.slug == slug)):
        slug = f"{base}-{n}"
        n += 1
    return slug


def _agent_out(agent: Agent) -> AgentOut:
    store = AgentStore(agent.slug)
    return AgentOut(
        id=agent.id,
        slug=agent.slug,
        name=agent.name,
        description=agent.description,
        system_prompt=agent.system_prompt,
        is_active=agent.is_active,
        invoice_count=len(store.list_invoices()),
        document_count=len(store.list_documents()),
        suggestions=agent.suggestions,
    )


# ---------- agents ----------


@router.get("/defaults")
async def agent_defaults() -> dict:
    """The two halves of every agent's prompt, for the console to prefill a
    new agent and to display the non-editable tool contract alongside it."""
    return {"default_persona": DEFAULT_PERSONA, "tool_contract": TOOL_CONTRACT}


@router.get("/agents", response_model=list[AgentOut])
async def agents_list(session: AsyncSession = Depends(get_session)) -> list[AgentOut]:
    rows = (
        await session.execute(select(Agent).order_by(Agent.created_at.asc()))
    ).scalars()
    return [_agent_out(a) for a in rows]


@router.post("/agents", response_model=AgentOut, status_code=201)
async def agent_create(
    body: AgentCreate, session: AsyncSession = Depends(get_session)
) -> AgentOut:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name is required")
    agent = Agent(
        slug=await _unique_slug(session, name),
        name=name,
        description=(body.description or "").strip() or None,
        system_prompt=(body.system_prompt or "").strip() or DEFAULT_PERSONA,
        is_active=body.is_active,
        suggestions=(body.suggestions or "").strip() or None,
    )
    session.add(agent)
    await session.commit()
    # Create the agent's (empty) data directory so uploads have somewhere to go.
    AgentStore(agent.slug).root.mkdir(parents=True, exist_ok=True)
    return _agent_out(agent)


@router.patch("/agents/{agent_id}", response_model=AgentOut)
async def agent_update(
    agent_id: str,
    body: AgentUpdate,
    session: AsyncSession = Depends(get_session),
) -> AgentOut:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Unknown agent")
    if body.name is not None and body.name.strip():
        agent.name = body.name.strip()
    if body.description is not None:
        agent.description = body.description.strip() or None
    if body.system_prompt is not None and body.system_prompt.strip():
        agent.system_prompt = body.system_prompt.strip()
    if body.is_active is not None:
        agent.is_active = body.is_active
    if body.suggestions is not None:
        agent.suggestions = body.suggestions.strip() or None
    await session.commit()
    return _agent_out(agent)


@router.delete("/agents/{agent_id}", status_code=204)
async def agent_delete(
    agent_id: str,
    purge: bool = False,
    session: AsyncSession = Depends(get_session),
) -> None:
    """Remove an agent. Its invoices are kept on disk unless ``purge=true``, so
    a deletion made by mistake is recoverable."""
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Unknown agent")
    slug = agent.slug
    await session.execute(delete(UserAgent).where(UserAgent.agent_id == agent_id))
    await session.delete(agent)
    await session.commit()
    if purge:
        AgentStore(slug).destroy()


# ---------- users ----------


async def _grants_of(session: AsyncSession, user_id: str) -> list[str]:
    rows = await session.execute(
        select(UserAgent.agent_id).where(UserAgent.user_id == user_id)
    )
    return [r[0] for r in rows]


async def _user_out(session: AsyncSession, user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at.isoformat() if user.created_at else None,
        agent_ids=await _grants_of(session, user.id),
    )


@router.get("/users", response_model=list[UserOut])
async def users_list(session: AsyncSession = Depends(get_session)) -> list[UserOut]:
    rows = (
        await session.execute(select(User).order_by(User.created_at.asc()))
    ).scalars()
    return [await _user_out(session, u) for u in rows]


@router.post("/users", response_model=UserOut, status_code=201)
async def user_create(
    body: UserCreate, session: AsyncSession = Depends(get_session)
) -> UserOut:
    username = body.username.strip()
    if not username or not body.password:
        raise HTTPException(status_code=422, detail="Username and password are required")
    if await session.scalar(select(User.id).where(User.username == username)):
        raise HTTPException(status_code=409, detail="That username is already taken")
    user = User(
        username=username,
        password_hash=hash_password(body.password),
        role=body.role,
    )
    session.add(user)
    await session.flush()
    for agent_id in dict.fromkeys(body.agent_ids):
        session.add(UserAgent(user_id=user.id, agent_id=agent_id))
    await session.commit()
    return await _user_out(session, user)


@router.patch("/users/{user_id}", response_model=UserOut)
async def user_update(
    user_id: str,
    body: UserUpdate,
    admin: CurrentUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Unknown user")
    # Don't let an admin lock themselves out of their own console.
    if user.id == admin.id and (body.role == "user" or body.is_active is False):
        raise HTTPException(
            status_code=400, detail="You cannot demote or deactivate your own account"
        )
    if body.password:
        user.password_hash = hash_password(body.password)
    if body.role is not None:
        user.role = body.role
    if body.is_active is not None:
        user.is_active = body.is_active
    await session.commit()
    return await _user_out(session, user)


@router.delete("/users/{user_id}", status_code=204)
async def user_delete(
    user_id: str,
    admin: CurrentUser = Depends(require_admin),
    session: AsyncSession = Depends(get_session),
) -> None:
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Unknown user")
    await session.execute(delete(UserAgent).where(UserAgent.user_id == user_id))
    await session.execute(
        delete(ChatSession).where(ChatSession.user_id == user_id)
    )
    await session.delete(user)
    await session.commit()


@router.put("/users/{user_id}/agents", response_model=UserOut)
async def user_grants(
    user_id: str,
    body: GrantsUpdate,
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    """Replace a user's agent access with exactly the given set."""
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Unknown user")
    wanted = list(dict.fromkeys(body.agent_ids))
    known = set(
        (await session.execute(select(Agent.id).where(Agent.id.in_(wanted)))).scalars()
    ) if wanted else set()
    unknown = [a for a in wanted if a not in known]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown agent(s): {unknown}")

    await session.execute(delete(UserAgent).where(UserAgent.user_id == user_id))
    for agent_id in wanted:
        session.add(UserAgent(user_id=user_id, agent_id=agent_id))
    await session.commit()
    return await _user_out(session, user)
