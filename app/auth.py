"""Authentication and authorization.

Login exchanges a username/password for a JWT. Every subsequent request carries
it as a Bearer header (added by the frontend's fetch wrapper) or as the
``fa_auth`` cookie — the cookie exists because browser-native requests such as
an iframe/img `src` or a download link cannot set custom headers, and those are
what render the invoice preview dock.
"""

from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import Agent, User, UserAgent, get_session
from app.schemas import AgentSummary, LoginRequest, LoginResponse, MeResponse, UserOut
from app.security import create_token, verify_password

router = APIRouter(tags=["auth"])


@dataclass
class CurrentUser:
    id: str
    username: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def bearer_token(request: Request) -> str | None:
    """The raw JWT from the Authorization header, else the fa_auth cookie."""
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip()
    return request.cookies.get("fa_auth")


async def current_user(request: Request) -> CurrentUser:
    """The authenticated caller. The middleware in app.main has already verified
    the token and stashed the claims, so this is just a typed accessor."""
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


async def require_admin(user: CurrentUser = Depends(current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def granted_agents(session: AsyncSession, user: CurrentUser) -> list[Agent]:
    """Active agents this user may use. Admins see all of them; everyone else
    sees only what they were explicitly granted."""
    stmt = select(Agent).where(Agent.is_active.is_(True))
    if not user.is_admin:
        stmt = stmt.join(UserAgent, UserAgent.agent_id == Agent.id).where(
            UserAgent.user_id == user.id
        )
    stmt = stmt.order_by(Agent.name.asc())
    return list((await session.execute(stmt)).scalars())


async def agent_access(
    agent_id: str,
    user: CurrentUser = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Agent:
    """Dependency for every ``/agents/{agent_id}/…`` route: resolves the agent
    and refuses it unless the caller was granted access. Returns 404 for an
    unknown agent and 403 for a known one the user may not use."""
    agent = await session.get(Agent, agent_id)
    if agent is None or not agent.is_active:
        raise HTTPException(status_code=404, detail="Unknown agent")
    if user.is_admin:
        return agent
    granted = await session.scalar(
        select(UserAgent.agent_id).where(
            UserAgent.user_id == user.id, UserAgent.agent_id == agent_id
        )
    )
    if granted is None:
        raise HTTPException(status_code=403, detail="You do not have access to this agent")
    return agent


def _agent_summary(agent: Agent) -> AgentSummary:
    return AgentSummary(
        id=agent.id,
        slug=agent.slug,
        name=agent.name,
        description=agent.description,
    )


@router.post("/auth/login", response_model=LoginResponse)
async def login(
    body: LoginRequest,
    session: AsyncSession = Depends(get_session),
) -> LoginResponse:
    """Exchange credentials for an access token. Wrong username and wrong
    password give the same response so neither can be probed."""
    account = await session.scalar(
        select(User).where(User.username == body.username.strip())
    )
    if (
        account is None
        or not account.is_active
        or not verify_password(body.password, account.password_hash)
    ):
        raise HTTPException(status_code=401, detail="Incorrect username or password")

    caller = CurrentUser(id=account.id, username=account.username, role=account.role)
    agents = await granted_agents(session, caller)
    return LoginResponse(
        access_token=create_token(account.id, account.username, account.role),
        user=UserOut(
            id=account.id,
            username=account.username,
            role=account.role,
            is_active=account.is_active,
        ),
        agents=[_agent_summary(a) for a in agents],
    )


@router.get("/auth/me", response_model=MeResponse)
async def me(
    user: CurrentUser = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> MeResponse:
    """Who the caller is and which agents they can chat with — this is what the
    frontend renders its agent switcher from."""
    agents = await granted_agents(session, user)
    return MeResponse(
        user=UserOut(id=user.id, username=user.username, role=user.role),
        agents=[_agent_summary(a) for a in agents],
    )
