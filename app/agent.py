import json

from app.config import settings
from app.llm import chat_completion
from app.schemas import AskResponse, ChartSpec
from app.store import (
    aggregate,
    list_documents,
    list_invoices,
    read_document,
    read_invoice,
)

SYSTEM_PROMPT = (
    "You are a finance assistant. You answer ONLY from the user's stored data — "
    "their invoices AND any uploaded finance documents (bank statements, P&L, "
    "reports, etc.) — accessed through your tools. Never use outside knowledge "
    "and never invent numbers or facts.\n"
    "\n"
    "Invoices are structured (use the aggregate/list/read invoice tools for "
    "totals, charts, and invoice details). Finance documents are free-form text — "
    "for questions about them, use list_documents to find the right one and "
    "read_document to read it, then answer from its content and name the document. "
    "If a question could relate to either, check both.\n"
    "\n"
    "Tools:\n"
    "- `aggregate_invoices(metric, group_by, where)`: the ONLY correct way to "
    "get totals, counts, and breakdowns — it computes exact numbers for you. "
    "metric is total_amount | taxable_value | tax_amount | cgst | sgst | igst | "
    "count. group_by can be ANY invoice field (buyer_state, seller_state, "
    "buyer_city, buyer_name, currency, …) or 'month', or omit it for a grand "
    "total. `where` restricts to a subset via equality filters on any field. "
    'For "sales by state" use metric=total_amount, group_by=buyer_state (the '
    'place of supply). For "monthly growth" use group_by=month. For a question '
    'about ONE state over time (e.g. "Karnataka by month") you MUST filter: '
    'where={"buyer_state":"Karnataka"} with group_by=month — never use the '
    "unfiltered monthly totals. To restrict to a year, filter "
    'where={"year":"2026"} (the year is derived from invoice_date; do NOT '
    'filter where={"invoice_date":"2026"} — that matches nothing). For a '
    '"YEAR pie chart" (e.g. amount vs tax for 2026) filter where={"year":"2026"} '
    "and read the returned totals.\n"
    "- `render_chart(chart_type, title, labels, values)`: draw a pie/line/bar "
    "chart. Pass the labels and values returned by aggregate_invoices verbatim.\n"
    "- `list_invoices`: raw fields of every invoice — only for inspecting or "
    "listing, NOT for math.\n"
    "- `read_invoice(name)`: full detail of one invoice (line items, HSN codes, "
    "GSTINs, PO number, original text) — for line-item or specific-invoice "
    "questions.\n"
    "\n"
    "Rules:\n"
    "- NEVER guess or fabricate. The only data you have is the fields returned by "
    "the tools (invoice_no, dates, parties, states, cities, GSTINs, amounts, tax, "
    "currency, HSN, line items). If the user asks about a status or attribute "
    "that is NOT among those fields — e.g. cancelled, paid/unpaid, overdue, "
    "approved, returned, discount — do NOT invent an answer or an invoice number. "
    "Say plainly that the invoices do not track that information. Do not 'reason "
    "out loud' toward a guess; if you cannot point to it in a tool result, you do "
    "not know it.\n"
    "- NEVER add up or compute figures yourself — always call "
    "aggregate_invoices and report its numbers exactly. Doing arithmetic by hand "
    "is forbidden because it is error-prone.\n"
    "- For a chart, call aggregate_invoices first, then render_chart with those "
    "exact labels/values, then give a one-line text takeaway.\n"
    "- If there are no invoices, or a needed field is missing, say so plainly. "
    "If aggregate reports multiple currencies, flag that you should not sum "
    "across them.\n"
    "- For comparisons (across states, months, buyers, etc.) present the numbers "
    "as a GitHub-flavored Markdown table with a header row and one row per item, "
    "so the user gets a clean tabular view. A chart can accompany the table when "
    "useful."
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "aggregate_invoices",
            "description": (
                "Exact total/count/breakdown across invoices, computed in code. "
                "Use this for every number and chart. Use `where` to restrict to "
                "a subset (e.g. one state) and `group_by` to break the result "
                "down (e.g. by month)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "metric": {
                        "type": "string",
                        "enum": [
                            "total_amount",
                            "taxable_value",
                            "tax_amount",
                            "cgst",
                            "sgst",
                            "igst",
                            "count",
                        ],
                    },
                    "group_by": {
                        "type": "string",
                        "description": (
                            "Any invoice field to break the result down by — e.g. "
                            "buyer_state, seller_state, buyer_city, seller_city, "
                            "buyer_name, currency, 'month' (groups invoice_date by "
                            "yyyy-mm) or 'year' (yyyy). Omit for a grand total."
                        ),
                    },
                    "where": {
                        "type": "object",
                        "description": (
                            "Optional equality filters on any field(s), e.g. "
                            '{"buyer_state": "Karnataka"} or {"month": "2026-02"} '
                            'or {"year": "2026"} or {"buyer_city": "Ahmedabad"}. '
                            'For a whole year use {"year": "2026"} (NOT '
                            '{"invoice_date": "2026"}).'
                        ),
                        "additionalProperties": {"type": "string"},
                    },
                },
                "required": ["metric"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_invoices",
            "description": (
                "List all stored invoices with their structured fields "
                "(amounts, tax, state, date, parties). Use for aggregation."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_invoice",
            "description": "Read the full detail of one invoice by its name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Invoice name."}
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_documents",
            "description": (
                "List the uploaded finance documents (bank statements, P&L, "
                "reports, etc.) — these are NOT invoices. Returns name + title."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": (
                "Read the full text of one finance document to answer questions "
                "about it. Pass the document's `name` from list_documents (its "
                "title or original filename also work)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Document name, title, or filename.",
                    }
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "render_chart",
            "description": (
                "Render a chart in the UI from already-aggregated data."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "chart_type": {
                        "type": "string",
                        "enum": ["pie", "line", "bar"],
                    },
                    "title": {"type": "string"},
                    "labels": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Category/x-axis labels.",
                    },
                    "values": {
                        "type": "array",
                        "items": {"type": "number"},
                        "description": "Numeric value per label, same order.",
                    },
                },
                "required": ["chart_type", "title", "labels", "values"],
            },
        },
    },
]

_MAX_ROUNDS = 6


async def _run_tool(
    name: str,
    args: dict,
    chart_box: list[ChartSpec],
    sources: set[str],
    aggregated: set[str],
    doc_sources: set[str],
) -> str:
    if name == "aggregate_invoices":
        result = aggregate(
            args.get("metric", "total_amount"),
            args.get("group_by"),
            args.get("where"),
        )
        # Record exactly the invoices this aggregate covered (after filtering)
        # for accurate "Based on N invoices" provenance.
        aggregated.update(result.get("names", []))
        return json.dumps(result)
    if name == "list_invoices":
        invoices = list_invoices()
        if len(invoices) <= 3:
            sources.update(inv["name"] for inv in invoices if "name" in inv)
        return json.dumps(invoices)
    if name == "read_invoice":
        inv = args.get("name", "")
        content = read_invoice(inv)
        if content is None:
            return "Invoice not found."
        sources.add(inv)  # record the invoice the agent actually used
        return content
    if name == "list_documents":
        return json.dumps(list_documents())
    if name == "read_document":
        doc = args.get("name", "")
        content = read_document(doc)
        if content is None:
            return "Document not found."
        doc_sources.add(doc)
        return content
    if name == "render_chart":
        labels = [str(x) for x in args.get("labels", [])]
        values = [float(v) for v in args.get("values", [])]
        chart_box.append(
            ChartSpec(
                type=args.get("chart_type", "bar"),
                title=args.get("title", ""),
                labels=labels,
                values=values,
            )
        )
        return json.dumps({"ok": True, "rendered": len(labels)})
    return json.dumps({"error": f"unknown tool {name}"})


async def answer_question(
    question: str,
    history: list[dict] | None = None,
) -> AskResponse:
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": question})

    chart_box: list[ChartSpec] = []
    sources: set[str] = set()
    aggregated: set[str] = set()
    doc_sources: set[str] = set()

    for _ in range(_MAX_ROUNDS):
        completion = await chat_completion(
            model=settings.llm_model,
            messages=messages,
            tools=TOOLS,
            temperature=0,  # deterministic — minimise "creative" guessing
        )
        msg = completion.choices[0].message

        if not msg.tool_calls:
            return AskResponse(
                answer=msg.content or "",
                chart=chart_box[-1] if chart_box else None,
                sources=sorted(sources),
                aggregated=sorted(aggregated),
                doc_sources=sorted(doc_sources),
            )

        messages.append(msg.model_dump(exclude_none=True))
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            result = await _run_tool(
                call.function.name, args, chart_box, sources, aggregated, doc_sources
            )
            messages.append(
                {"role": "tool", "tool_call_id": call.id, "content": result}
            )

    # Ran out of rounds — return whatever we have.
    return AskResponse(
        answer=(
            "I wasn't able to finish answering that. Please try rephrasing or "
            "narrowing the question."
        ),
        chart=chart_box[-1] if chart_box else None,
        sources=sorted(sources),
        aggregated=sorted(aggregated),
        doc_sources=sorted(doc_sources),
    )
