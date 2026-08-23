# invoice-agent

Multi-agent invoice analytics — an admin configures agents and accounts, users
upload invoices to the agents they were granted and ask questions, and the answers
come back with exact totals and charts.

This is a sibling of the semantic-RAG app (`main` branch). RAG is the wrong tool
for **aggregation** ("total of 100 invoices", "state-wise sales") — vector search
only returns the top-k *similar* chunks, so the model never sees every invoice.
Here we extract each invoice to **structured markdown** and compute over all of
them deterministically.

## How it works

```
upload → MarkItDown → LLM extraction → invoice_data/agents/<slug>/<no>.md
ask    → agent → aggregate_invoices (exact, in code) → answer (+ rendered chart)
```

- **Extraction (write):** each invoice is parsed and the LLM pulls structured
  fields (invoice no, date, seller/buyer, state, currency, total, tax) into a
  markdown file's YAML frontmatter.
- **Query agent (read):** answers only from the stored invoices via tools:
  - `aggregate_invoices(metric, group_by)` — **exact** totals/counts/breakdowns,
    computed in Python (the LLM never does the arithmetic).
  - `list_invoices` / `read_invoice(name)` — inspect or drill into invoices.
  - `render_chart(type, title, labels, values)` — draws a pie/line/bar in the UI.
- **Frontend:** monochrome single-page UI with Chart.js for rendered charts.

The key design rule: **numbers come from code, prose comes from the LLM.** That's
what makes "total tax of all invoices" correct instead of a best guess.

## Agents, users and access

Multiple agents can exist side by side. An agent is a **name + system prompt +
its own document store** — the toolset is fixed in code and is the same for
every agent, so an agent is configuration, never new plumbing.

- **Admins** manage everything from the console at **`/admin`**: create and edit
  agents (including their system prompt), create user accounts, and tick exactly
  which agents each user may use.
- **Users** sign in, pick an agent from the switcher, and get that agent's
  invoices, documents and conversation history — and nothing else. Uploads go to
  whichever agent is currently selected.

Auth is per-user **JWT**. The token is sent as a `Bearer` header and mirrored
into an `fa_auth` cookie so browser-native requests (preview iframes, download
links) authenticate too.

### The system prompt is in two halves

Only the **persona** half lives in the database and is editable in the console.
The **tool contract** — "never do the arithmetic yourself, always call
`aggregate_invoices`, chart its exact values" — lives in `app/agent.py` and is
appended to every prompt. That way a careless prompt edit can change an agent's
voice and scope but can never turn its numbers back into guesses.

### First run

On first startup the app seeds an admin from `AUTH_USERNAME`/`AUTH_PASSWORD`,
creates a default **Invoice Analyst** agent, and moves any pre-existing
`invoice_data/*.md` into that agent's folder — so an upgrade keeps its data.

## Sample questions

- Give total tax amount from all invoices
- State wise sales pie chart
- Company growth line chart by month by sales

## Ports

- Postgres → **9432** (users, agents, grants, sessions/messages — no pgvector here)
- API → **9001**

## Setup (local)

```bash
uv sync
cp .env.example .env          # fill in LLM_API_KEY, JWT_SECRET, admin credentials
docker compose up -d db       # Postgres on 9432
uv run uvicorn app.main:app --port 9001
```

Then open http://localhost:9001/ and sign in with `AUTH_USERNAME` /
`AUTH_PASSWORD`; the admin console is at http://localhost:9001/admin.

## Run with Docker

Full stack (Postgres + app) via compose — fill in `.env` first:

```bash
cp .env.example .env          # LLM_API_KEY (DATABASE_URL is set by compose)
docker compose up --build     # app on http://localhost:9001
```

Or run the published image against your own Postgres:

```bash
docker run -p 9001:9001 \
  -e LLM_API_KEY=sk-... \
  -e DATABASE_URL=postgresql+asyncpg://user:pass@host:5432/agentvector \
  -v "$PWD/invoice_data:/app/invoice_data" \
  bhutiyalakhan/invoice-agent:latest
```

Image: **`bhutiyalakhan/invoice-agent`** on Docker Hub (`:latest`, `:0.1.0`).

## Ship as a turnkey app (`dist/`)

`dist/` is a self-contained bundle to hand a client — it pulls **both** the app
image and Postgres, so there's nothing else to install:

1. Copy `dist/` to the client (or zip it).
2. `cp .env.example .env` and put the OpenAI key in `.env`
   (**set a hard spend cap on that key** in the OpenAI dashboard).
3. `docker compose up -d`
4. Open **http://localhost:9000**

The key lives only in the client's `.env` — it is **never** baked into the
public image. Extracted invoices persist in `./invoice_data`, the database in a
named volume.

Open **http://localhost:9001/**.

## Endpoints

| Method | Path                                     | Purpose                                   |
|--------|------------------------------------------|-------------------------------------------|
| POST   | `/auth/login`                            | credentials → JWT + the caller's agents    |
| GET    | `/auth/me`                               | who you are + which agents you may use     |
| GET/POST/PATCH/DELETE | `/admin/agents...`        | manage agents (admin only)                 |
| GET/POST/PATCH/DELETE | `/admin/users...`         | manage accounts (admin only)               |
| PUT    | `/admin/users/{id}/agents`               | set a user's agent access (admin only)     |
| POST   | `/agents/{id}/ingest/file[s]`            | upload → extract → store on that agent     |
| GET    | `/agents/{id}/invoices`                  | structured rows for that agent's invoices  |
| GET/DELETE | `/agents/{id}/invoices/{name}`       | detail / delete one invoice                |
| GET    | `/agents/{id}/documents...`              | finance documents (non-invoice)            |
| POST   | `/agents/{id}/ask`                       | `{question, session_id?}` → answer + chart |
| GET/POST/DELETE | `/agents/{id}/sessions...`      | conversation sessions (yours only)         |

Everything under `/agents/{id}/…` is refused unless you were granted that agent.

## Layout

```
app/
  config.py    settings
  security.py  password hashing (pbkdf2) + JWT issue/verify
  auth.py      login, /auth/me, and the access guards
  admin.py     admin console API: agents, users, grants
  db.py        users + agents + grants + sessions/messages (Postgres)
  parsing.py   MarkItDown: file bytes → markdown
  extract.py   invoice extraction (the "write" side)
  store.py     AgentStore: one markdown store per agent + exact aggregate()
  agent.py     query agent: persona + fixed tool contract, and the tools
  sessions.py  conversation turns (scoped to user + agent)
  main.py      FastAPI routes + static frontend
web/
  index.html, js/app.js       chat app
  admin.html,  js/admin.js    admin console
  styles.css, js/chart.umd.min.js (+ marked, purify, xlsx, mammoth)
invoice_data/agents/<slug>/   one isolated store per agent
```
