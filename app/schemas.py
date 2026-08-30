from typing import Literal

from pydantic import BaseModel


class IngestResponse(BaseModel):
    name: str
    kind: Literal["invoice", "document"] = "invoice"
    title: str | None = None  # for finance documents
    invoice_no: str | None = None
    total_amount: float | None = None
    tax_amount: float | None = None
    currency: str | None = None


class AskRequest(BaseModel):
    question: str
    session_id: str | None = None


class ChartSpec(BaseModel):
    type: Literal["pie", "line", "bar"]
    title: str
    labels: list[str]
    values: list[float]


class AskResponse(BaseModel):
    answer: str
    chart: ChartSpec | None = None
    sources: list[str] = []  # specific invoices the agent read for this answer
    aggregated: list[str] = []  # invoices covered by an aggregate (totals/charts)
    doc_sources: list[str] = []  # finance documents the agent read
    session_id: str | None = None


class SessionResponse(BaseModel):
    session_id: str


class SessionSummary(BaseModel):
    session_id: str
    title: str
    message_count: int
    last_active: str | None = None


class MessageOut(BaseModel):
    role: str
    content: str
    chart: ChartSpec | None = None
    sources: list[str] = []
    aggregated: list[str] = []
    doc_sources: list[str] = []


# ---------- auth ----------
class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: str
    username: str
    role: str
    is_active: bool = True
    created_at: str | None = None
    agent_ids: list[str] = []  # populated by the admin listing only


class AgentSummary(BaseModel):
    """What a user needs to pick an agent — no system prompt."""

    id: str
    slug: str
    name: str
    description: str | None = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
    agents: list[AgentSummary] = []


class MeResponse(BaseModel):
    user: UserOut
    agents: list[AgentSummary] = []


class AgentStats(BaseModel):
    """Fetched lazily for the selected agent only — never bundled into
    AgentSummary/MeResponse, since computing it reads and parses every
    invoice/document file on disk (see AgentStore.list_invoices)."""

    invoices: int
    documents: int


class AgentSuggestions(BaseModel):
    questions: list[str]


# ---------- admin ----------
class AgentOut(AgentSummary):
    """Full agent record for the admin console, including the editable prompt."""

    system_prompt: str
    is_active: bool = True
    invoice_count: int = 0
    document_count: int = 0
    suggestions: str | None = None  # newline-separated; None falls back to a default list


class AgentCreate(BaseModel):
    name: str
    description: str | None = None
    system_prompt: str | None = None  # falls back to the default persona
    is_active: bool = True
    suggestions: str | None = None


class AgentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    system_prompt: str | None = None
    is_active: bool | None = None
    suggestions: str | None = None


class UserCreate(BaseModel):
    username: str
    password: str
    role: Literal["admin", "user"] = "user"
    agent_ids: list[str] = []


class UserUpdate(BaseModel):
    password: str | None = None
    role: Literal["admin", "user"] | None = None
    is_active: bool | None = None


class GrantsUpdate(BaseModel):
    agent_ids: list[str] = []
