"""Markdown invoice store.

Each invoice is a single ``.md`` file: a YAML frontmatter block of structured
fields (the bits we compute over — amounts, tax, state, date, parties) followed
by a human-readable body. This replaces the vector store: aggregation and charts
read the frontmatter of *every* invoice in one cheap pass, so answers are exact
instead of "best guess from the top-k similar chunks".
"""

import re
from pathlib import Path

import yaml

from app.config import settings

INVOICE_DIR = Path(settings.invoice_dir).resolve()
# Original uploaded files (PDF/image/…) kept so the user can preview the real
# document behind an answer, not just the extracted data.
ORIGINALS_DIR = INVOICE_DIR / "originals"


def save_original(name: str, filename: str, data: bytes) -> str:
    """Persist the original uploaded file next to its extracted invoice, keyed by
    the invoice's stored name. Returns the stored filename."""
    ORIGINALS_DIR.mkdir(parents=True, exist_ok=True)
    ext = Path(filename).suffix.lower() or ".bin"
    path = ORIGINALS_DIR / f"{name}{ext}"
    path.write_bytes(data)
    return path.name


def original_path(name: str) -> Path | None:
    """Path to the original uploaded file for an invoice, or None if not kept."""
    stem = Path(name).stem
    if not ORIGINALS_DIR.exists():
        return None
    for path in ORIGINALS_DIR.glob(f"{stem}.*"):
        return path
    return None

# Numeric frontmatter fields the agent can total/chart (the metric enum).
NUMERIC_FIELDS = ["taxable_value", "tax_amount", "total_amount", "cgst", "sgst", "igst"]
# String fields the agent can group/filter by.
GROUP_FIELDS = ["buyer_state", "seller_state", "currency", "month"]


def _slug(value: str) -> str:
    """Filesystem-safe stem derived from a value (e.g. an invoice number)."""
    s = re.sub(r"[^A-Za-z0-9]+", "-", value.strip()).strip("-").lower()
    return s or "invoice"


def _unique_path(stem: str) -> Path:
    """A non-colliding ``<stem>.md`` path inside the invoice dir."""
    path = INVOICE_DIR / f"{stem}.md"
    n = 2
    while path.exists():
        path = INVOICE_DIR / f"{stem}-{n}.md"
        n += 1
    return path


def _resolve(name: str) -> Path:
    """Resolve a stored name to a path, guarding against traversal."""
    path = (INVOICE_DIR / f"{Path(name).stem}.md").resolve()
    if INVOICE_DIR not in path.parents:
        raise ValueError("invalid invoice name")
    return path


def find_existing(invoice_no, seller) -> str | None:
    """Return the stored name of an invoice with the same number AND seller —
    i.e. a likely duplicate — or None. Lets the caller ask the user whether to
    replace it or keep both, instead of silently overwriting or double-counting.
    Different sellers sharing a number are NOT treated as duplicates."""
    inv = str(invoice_no or "").strip().lower()
    if not inv or not INVOICE_DIR.exists():
        return None
    sel = str(seller or "").strip().lower()
    for path in INVOICE_DIR.glob("*.md"):
        front, _ = _parse(path.read_text(encoding="utf-8"))
        if (
            str(front.get("invoice_no") or "").strip().lower() == inv
            and str(front.get("seller_name") or "").strip().lower() == sel
        ):
            return path.stem
    return None


def save_invoice(fields: dict, body: str, name: str | None = None) -> str:
    """Persist one invoice as ``frontmatter + body`` markdown. If ``name`` is
    given, overwrite that file (a user-confirmed replace); otherwise create a
    new, non-colliding file. Returns the stored name (without ``.md``)."""
    INVOICE_DIR.mkdir(parents=True, exist_ok=True)
    if name:
        path = _resolve(name)
    else:
        path = _unique_path(_slug(str(fields.get("invoice_no") or "invoice")))
    front = yaml.safe_dump(fields, sort_keys=False, allow_unicode=True).strip()
    path.write_text(f"---\n{front}\n---\n\n{body.strip()}\n", encoding="utf-8")
    return path.stem


def _parse(text: str) -> tuple[dict, str]:
    """Split a stored file into (frontmatter dict, body)."""
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    try:
        front = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        front = {}
    return (front if isinstance(front, dict) else {}), m.group(2).strip()


# Bulky fields excluded from the compact list view (still in the file, available
# via read_invoice). Keeps the list_invoices tool payload small for many invoices.
_LIST_EXCLUDE = {"line_items", "additional_fields"}


def list_invoices() -> list[dict]:
    """Compact structured frontmatter for every stored invoice (one row each).
    This is what the agent aggregates over for totals and charts; per-invoice
    line items live in the file and are fetched via read_invoice."""
    if not INVOICE_DIR.exists():
        return []
    rows: list[dict] = []
    for path in sorted(INVOICE_DIR.glob("*.md")):
        front, _ = _parse(path.read_text(encoding="utf-8"))
        row = {k: v for k, v in front.items() if k not in _LIST_EXCLUDE}
        rows.append({"name": path.stem, **row})
    return rows


def _month_of(row: dict) -> str:
    """Invoice month as yyyy-mm, tolerant of ISO (2026-04-20) and
    day-first (20/04/2026 or 20-04-2026) date strings."""
    d = str(row.get("invoice_date") or "").strip()
    if re.match(r"^\d{4}-\d{2}", d):  # ISO yyyy-mm-dd
        return d[:7]
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})", d)  # dd/mm/yyyy
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}"
    return d[:7] or "unknown"


def _year_of(row: dict) -> str:
    """Invoice year as yyyy, from any recognizable date string."""
    d = str(row.get("invoice_date") or "")
    if re.match(r"^\d{4}-", d):  # ISO
        return d[:4]
    m = re.search(r"\d{4}", d)  # any 4-digit year (e.g. dd/mm/yyyy)
    return m.group(0) if m else "unknown"


def _key_of(row: dict, field: str) -> str:
    """Value used for grouping/filtering by `field`. Supports the virtual
    'month' (yyyy-mm) and 'year' (yyyy); everything else is a raw field."""
    if field == "month":
        return _month_of(row)
    if field == "year":
        return _year_of(row)
    return str(row.get(field) or "")


def _matches(row: dict, where: dict | None) -> bool:
    """Case-insensitive equality filter. Keys are frontmatter fields
    (buyer_state, seller_state, currency, …) or the virtual "month"
    (yyyy-mm) / "year" (yyyy)."""
    if not where:
        return True
    for key, val in where.items():
        if val in (None, ""):
            continue
        actual = _key_of(row, key)
        if actual.strip().lower() != str(val).strip().lower():
            return False
    return True


def aggregate(
    metric: str = "total_amount",
    group_by: str | None = None,
    where: dict | None = None,
) -> dict:
    """Exact aggregation over invoice frontmatter — computed in Python, never by
    the LLM, so totals and chart values are correct.

    metric: "total_amount" | "tax_amount" | "count".
    group_by: None for a grand total, else a field name ("buyer_state",
    "seller_state", "currency") or "month" (groups invoice_date by yyyy-mm).
    where: optional equality filters, e.g. {"buyer_state": "Karnataka"} or
    {"month": "2026-02"} — only matching invoices are included.
    Returns the grand total, optional grouped rows, the currencies seen, and the
    NAMES of the invoices actually included (so provenance is accurate).
    """
    rows = [r for r in list_invoices() if _matches(r, where)]

    def value_of(row: dict) -> float:
        return 1.0 if metric == "count" else float(row.get(metric) or 0)

    currencies = sorted({r.get("currency") for r in rows if r.get("currency")})
    total = round(sum(value_of(r) for r in rows), 2)
    names = [r["name"] for r in rows]

    if not group_by:
        return {
            "metric": metric,
            "group_by": None,
            "where": where or None,
            "total": total,
            "count": len(rows),
            "currencies": currencies,
            "names": names,
        }

    groups: dict[str, float] = {}
    for r in rows:
        key = _key_of(r, group_by) or "unknown"
        groups[key] = round(groups.get(key, 0.0) + value_of(r), 2)

    # Dates read best chronologically; other groupings by descending value.
    items = sorted(
        groups.items(),
        key=(lambda kv: kv[0]) if group_by in ("month", "year") else (lambda kv: -kv[1]),
    )
    return {
        "metric": metric,
        "group_by": group_by,
        "where": where or None,
        "total": total,
        "count": len(rows),
        "currencies": currencies,
        "groups": [{"label": k, "value": v} for k, v in items],
        "names": names,
    }


def _find(name: str) -> Path | None:
    """Locate an invoice by its stored name OR its invoice number (both
    case-insensitive), so callers can use whichever they have."""
    direct = _resolve(name)
    if direct.exists():
        return direct
    target = name.strip().lower()
    for path in INVOICE_DIR.glob("*.md") if INVOICE_DIR.exists() else []:
        if path.stem.lower() == target:
            return path
        front, _ = _parse(path.read_text(encoding="utf-8"))
        if str(front.get("invoice_no") or "").strip().lower() == target:
            return path
    return None


def read_invoice(name: str) -> str | None:
    """Full markdown content of one invoice (frontmatter + body), truncated to
    the read budget. Accepts the stored name or the invoice number. Returns None
    if not found."""
    path = _find(name)
    if path is None:
        return None
    return path.read_text(encoding="utf-8")[: settings.read_char_limit]


def delete_invoice(name: str) -> bool:
    path = _resolve(name)
    if not path.exists():
        return False
    path.unlink()
    orig = original_path(name)
    if orig:
        orig.unlink(missing_ok=True)
    return True


# ---------------------------------------------------------------------------
# Finance documents (non-invoice). Stored as full parsed text so the agent can
# read and answer questions about them. Kept apart from the invoice analytics.
# ---------------------------------------------------------------------------

DOCS_DIR = INVOICE_DIR / "documents"
DOCS_ORIGINALS_DIR = DOCS_DIR / "originals"


def _doc_path(name: str) -> Path:
    path = (DOCS_DIR / f"{Path(name).stem}.md").resolve()
    if DOCS_DIR.resolve() not in path.parents:
        raise ValueError("invalid document name")
    return path


def save_document(title: str, body: str, filename: str, data: bytes) -> str:
    """Store a finance document as ``frontmatter + full text`` and keep its
    original file. Returns the stored name."""
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    stem = _slug(title or filename)
    path = DOCS_DIR / f"{stem}.md"
    n = 2
    while path.exists():
        path = DOCS_DIR / f"{stem}-{n}.md"
        n += 1
    front = yaml.safe_dump(
        {"title": title, "source_file": filename, "type": "document"},
        sort_keys=False,
        allow_unicode=True,
    ).strip()
    path.write_text(f"---\n{front}\n---\n\n{body.strip()}\n", encoding="utf-8")
    # Keep the original for download/preview.
    DOCS_ORIGINALS_DIR.mkdir(parents=True, exist_ok=True)
    ext = Path(filename).suffix.lower() or ".bin"
    (DOCS_ORIGINALS_DIR / f"{path.stem}{ext}").write_bytes(data)
    return path.stem


def list_documents() -> list[dict]:
    """Title/name of every stored finance document."""
    if not DOCS_DIR.exists():
        return []
    rows: list[dict] = []
    for path in sorted(DOCS_DIR.glob("*.md")):
        front, _ = _parse(path.read_text(encoding="utf-8"))
        rows.append(
            {
                "name": path.stem,
                "title": front.get("title") or path.stem,
                "source_file": front.get("source_file"),
            }
        )
    return rows


def _find_doc(name: str) -> Path | None:
    """Locate a finance document by its stored name, its title, or its original
    filename — all case-insensitively — so the agent can pass whichever string
    it has (the model often passes the title or source_file, not the slug)."""
    direct = _doc_path(name)
    if direct.exists():
        return direct
    if not DOCS_DIR.exists():
        return None
    target = name.strip().lower()
    target_slug = _slug(name)
    for path in DOCS_DIR.glob("*.md"):
        if path.stem.lower() in (target, target_slug):
            return path
        front, _ = _parse(path.read_text(encoding="utf-8"))
        title = str(front.get("title") or "").strip().lower()
        src = str(front.get("source_file") or "").strip().lower()
        if target in (title, src) or target_slug == _slug(title or src or ""):
            return path
    return None


def read_document(name: str) -> str | None:
    """Full text of one finance document (truncated to the read budget). Accepts
    the stored name, the title, or the original filename. None if not found."""
    path = _find_doc(name)
    if path is None:
        return None
    return path.read_text(encoding="utf-8")[: settings.doc_read_char_limit]


def doc_original_path(name: str) -> Path | None:
    stem = Path(name).stem
    if not DOCS_ORIGINALS_DIR.exists():
        return None
    for path in DOCS_ORIGINALS_DIR.glob(f"{stem}.*"):
        return path
    return None


def delete_document(name: str) -> bool:
    path = _doc_path(name)
    if not path.exists():
        return False
    path.unlink()
    orig = doc_original_path(name)
    if orig:
        orig.unlink(missing_ok=True)
    return True
