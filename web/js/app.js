"use strict";

const $ = (sel) => document.querySelector(sel);
const SESSION_KEY = "invoice-agent.session";
const PREVIEW_WIDTH_KEY = "invoice-agent.previewWidth";

let sessionId = localStorage.getItem(SESSION_KEY) || null;
let currentPreview = null; // name of the invoice currently shown in the dock

/* ---------- auth (single shared login, see /health-gated middleware) ---------- */
const AUTH_KEY = "invoice-agent.auth"; // sessionStorage: base64(user:pass)
const AUTH_USER_KEY = "invoice-agent.authUser";

const rawFetch = window.fetch.bind(window);
window.fetch = (input, opts = {}) => {
  const token = sessionStorage.getItem(AUTH_KEY);
  if (!token) return rawFetch(input, opts);
  const headers = new Headers(opts.headers || {});
  headers.set("Authorization", `Basic ${token}`);
  return rawFetch(input, { ...opts, headers });
};

async function checkAuth(token) {
  const r = await rawFetch("/health", { headers: { Authorization: `Basic ${token}` } });
  return r.ok;
}

function showApp() {
  $("#login-overlay").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  const username = sessionStorage.getItem(AUTH_USER_KEY) || "";
  $("#profile-name").textContent = username || "Account";
  $("#profile-avatar").textContent = username.slice(0, 2) || "?";
}

function showLogin() {
  $("#app-shell").classList.add("hidden");
  $("#login-overlay").classList.remove("hidden");
  $("#profile-menu").classList.add("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#login-username").value;
  const token = btoa(`${username}:${$("#login-password").value}`);
  const submit = $("#login-submit");
  submit.disabled = true;
  $("#login-error").classList.add("hidden");
  const ok = await checkAuth(token);
  submit.disabled = false;
  if (!ok) {
    $("#login-error").classList.remove("hidden");
    return;
  }
  sessionStorage.setItem(AUTH_KEY, token);
  sessionStorage.setItem(AUTH_USER_KEY, username);
  // Also store the token in a cookie so browser-native requests (iframe/img
  // src, download links like /original) are authenticated — those can't carry
  // the Authorization header the fetch wrapper adds.
  document.cookie = `fa_auth=${token}; path=/; max-age=86400; SameSite=Strict`;
  showApp();
  init();
});

$("#logout-btn").addEventListener("click", () => {
  sessionStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_USER_KEY);
  document.cookie = "fa_auth=; path=/; max-age=0; SameSite=Strict";
  location.reload();
});

/* ---------- account menu (bottom of history panel) ---------- */
$("#profile-card").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#profile-menu").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!$("#history-profile").contains(e.target)) $("#profile-menu").classList.add("hidden");
});

/* ---------- history collapse/expand ---------- */
$("#history-toggle").addEventListener("click", () => {
  const collapsed = $("#history-panel").classList.toggle("collapsed");
  $("#app-layout").classList.toggle("history-collapsed", collapsed);
  $("#history-toggle").setAttribute("aria-expanded", String(!collapsed));
});

/* ---------- tiny DOM helper ---------- */
function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Safe markdown via marked + DOMPurify (both vendored).
function renderMarkdown(s) {
  const parse = typeof marked.parse === "function" ? marked.parse : marked;
  return DOMPurify.sanitize(parse(prepareMarkdown(s || "")));
}

// If the content starts with a YAML front-matter block (--- ... ---),
// render it as a clean key/value table instead of letting marked squash it
// into a single paragraph. Non-front-matter content is left untouched.
function prepareMarkdown(s) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (!m) return s;
  return yamlToTable(m[1]);
}

// Lightweight YAML -> markdown table. Handles top-level scalars, empty
// collections, and a `line_items:` list of dash-prefixed objects. Skips
// null/empty values so the table stays compact. Not a general YAML parser —
// just enough for the invoice payloads this app stores.
function yamlToTable(yaml) {
  const lines = yaml.split(/\r?\n/);
  const fields = [];
  const items = [];
  let inItems = false;
  let current = null;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (/^line_items:\s*$/.test(raw)) { inItems = true; continue; }

    if (inItems) {
      const dash = /^\s*-\s*(.+?):\s*(.*)$/.exec(raw);
      const kv = /^\s{2,}(.+?):\s*(.*)$/.exec(raw);
      if (dash) {
        current = {};
        items.push(current);
        current[dash[1].trim()] = dash[2].trim();
      } else if (kv && current) {
        current[kv[1].trim()] = kv[2].trim();
      }
      continue;
    }

    const top = /^([^:]+):\s*(.*)$/.exec(raw);
    if (top) fields.push([top[1].trim(), top[2].trim()]);
  }

  const isEmpty = (v) =>
    v === "" || v === "null" || v === "[]" || v === "{}" || v == null;

  let out = "| Field | Value |\n|---|---|\n";
  for (const [k, v] of fields) {
    if (isEmpty(v)) continue;
    out += `| ${k} | ${escapePipes(v)} |\n`;
  }

  if (items.length) {
    out += "\n**Line items**\n\n";
    const keys = Array.from(
      items.reduce((set, it) => {
        Object.keys(it).forEach((k) => !isEmpty(it[k]) && set.add(k));
        return set;
      }, new Set())
    );
    out += "| " + keys.join(" | ") + " |\n";
    out += "|" + keys.map(() => "---").join("|") + "|\n";
    for (const it of items) {
      out += "| " + keys.map((k) => escapePipes(it[k] || "")).join(" | ") + " |\n";
    }
  }
  return out;
}

function escapePipes(v) {
  return String(v).replace(/\|/g, "\\|");
}

async function safeJson(r) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text.slice(0, 200) };
  }
}

function logIngest(message, isError) {
  const item = el("div", "log-item" + (isError ? " err" : ""));
  item.textContent = message;
  const log = $("#ingest-log");
  log.prepend(item);
  while (log.children.length > 8) log.lastChild.remove();
}

function setSessionLabel() {
  $("#session-label").textContent = sessionId
    ? `Session ${sessionId.slice(0, 8)}`
    : "No active session";
}

function relativeTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatMoney(n) {
  if (n === null || n === undefined || n === "") return "—";
  return Number(n).toLocaleString();
}

function extOf(name) {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function invoiceUrl(name) {
  return `/invoices/${encodeURIComponent(name)}`;
}
function originalUrl(name) {
  return `${invoiceUrl(name)}/original`;
}
function documentUrl(name) {
  return `/documents/${encodeURIComponent(name)}`;
}
// Detail / original URLs that work for both invoices and finance documents.
function detailUrl(name, type) {
  return type === "document" ? documentUrl(name) : invoiceUrl(name);
}
function previewOriginalUrl(name, type) {
  return `${detailUrl(name, type)}/original`;
}

/* ---------- connection status ---------- */
async function ping() {
  const dot = $("#status-dot");
  try {
    const r = await fetch("/health");
    dot.className = r.ok ? "dot online" : "dot offline";
    dot.title = r.ok ? "online" : "offline";
  } catch {
    dot.className = "dot offline";
    dot.title = "offline";
  }
}

/* ---------- confirmation modal ---------- */
function confirmDialog(text, sub) {
  return new Promise((resolve) => {
    const overlay = $("#confirm-overlay");
    $("#confirm-text").textContent = text;
    $("#confirm-sub").textContent = sub || "This cannot be undone.";
    overlay.classList.remove("hidden");
    const ok = $("#confirm-ok");
    const cancel = $("#confirm-cancel");
    const cleanup = (val) => {
      overlay.classList.add("hidden");
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => e.target === overlay && cleanup(false);
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter") cleanup(true);
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

/* ---------- session history sidebar ---------- */
async function loadSessions() {
  const list = $("#session-list");
  let sessions = [];
  try {
    const r = await fetch("/sessions");
    if (r.ok) sessions = await r.json();
  } catch {
    return;
  }
  if (!sessions.length) {
    list.innerHTML = `<p class="session-empty">No conversations yet.</p>`;
    return;
  }
  list.innerHTML = "";
  sessions.forEach((s) => {
    const item = el("div", "session-item" + (s.session_id === sessionId ? " active" : ""));
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.innerHTML =
      `<div class="session-item-body">` +
      `<span class="session-item-title">${escapeHtml(s.title)}</span>` +
      `<span class="session-item-meta">${s.message_count} msg · ${relativeTime(s.last_active)}</span>` +
      `</div>` +
      `<button class="session-del" title="Delete conversation" aria-label="Delete">` +
      `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ` +
      `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>` +
      `<path d="M10 11v6M14 11v6"/></svg></button>`;
    item.addEventListener("click", () => switchSession(s.session_id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter") switchSession(s.session_id);
    });
    item.querySelector(".session-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(s.session_id);
    });
    list.appendChild(item);
  });
}

async function switchSession(id) {
  if (id === sessionId) return;
  hideSuggestions();
  sessionId = id;
  localStorage.setItem(SESSION_KEY, id);
  setSessionLabel();
  thread.innerHTML = "";
  await loadMessages(id);
  loadSessions();
}

async function loadMessages(id) {
  try {
    const r = await fetch(`/sessions/${id}/messages`);
    thread.innerHTML = "";
    if (!r.ok) return;
    (await r.json()).forEach((m) =>
      addMessage(m.role, m.content, m.chart, m.sources, m.aggregated, m.doc_sources)
    );
  } catch {
    /* offline */
  }
}

async function deleteSession(id) {
  if (!(await confirmDialog("Delete this conversation?",
    "This removes the conversation and its messages."))) return;
  try {
    const r = await fetch(`/sessions/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error();
  } catch {
    return;
  }
  if (id === sessionId) resetThread();
  loadSessions();
}

/* ---------- invoices list ---------- */
const TRASH_SVG =
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>` +
  `<path d="M10 11v6M14 11v6"/></svg>`;

async function loadInvoices() {
  const list = $("#inv-list");
  let invs = [];
  try {
    const r = await fetch("/invoices");
    if (r.ok) invs = await r.json();
  } catch {
    return;
  }
  $("#inv-count").textContent = invs.length
    ? `${invs.length} invoice${invs.length > 1 ? "s" : ""}`
    : "";
  if (!invs.length) {
    list.innerHTML = `<p class="docs-empty">No invoices yet.</p>`;
    return;
  }
  list.innerHTML = "";
  invs.forEach((d) => {
    const item = el("div", "doc-item");
    const meta =
      `${d.buyer_state || "—"} · ${d.invoice_date || "—"}` +
      ` · ${d.currency || ""} ${formatMoney(d.total_amount)}`;
    item.innerHTML =
      `<button class="doc-item-body" title="Preview ${escapeHtml(d.invoice_no || d.name)}">` +
      `<span class="doc-item-name">${escapeHtml(d.invoice_no || d.name)}</span>` +
      `<span class="doc-item-meta">${escapeHtml(meta)}</span></button>` +
      `<button class="doc-del" title="Delete invoice" aria-label="Delete">${TRASH_SVG}</button>`;
    item.querySelector(".doc-item-body")
      .addEventListener("click", () => openPreview(d.name, d.invoice_no || d.name));
    item.querySelector(".doc-del")
      .addEventListener("click", () => deleteInvoice(d.name, d.invoice_no || d.name));
    list.appendChild(item);
  });
}

async function deleteInvoice(name, label) {
  if (!(await confirmDialog(`Delete invoice "${label}"?`,
    "This permanently removes the stored invoice."))) return;
  try {
    const r = await fetch(invoiceUrl(name), { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error();
    logIngest(`🗑 removed "${label}"`);
    if (currentPreview === name) closePreview();
  } catch {
    logIngest(`✕ could not delete "${label}"`, true);
  }
  loadInvoices();
}

/* ---------- finance documents list ---------- */
async function loadDocuments() {
  const list = $("#doc-list");
  if (!list) return;
  let docs = [];
  try {
    const r = await fetch("/documents");
    if (r.ok) docs = await r.json();
  } catch {
    return;
  }
  const count = $("#doc-count");
  if (count) count.textContent = docs.length ? `${docs.length}` : "";
  if (!docs.length) {
    list.innerHTML = `<p class="docs-empty">No finance documents yet.</p>`;
    return;
  }
  list.innerHTML = "";
  docs.forEach((d) => {
    const item = el("div", "doc-item");
    item.innerHTML =
      `<button class="doc-item-body" title="Preview ${escapeHtml(d.title || d.name)}">` +
      `<span class="doc-item-name">${escapeHtml(d.title || d.name)}</span>` +
      `<span class="doc-item-meta">${escapeHtml(d.source_file || "")}</span></button>` +
      `<button class="doc-del" title="Delete document" aria-label="Delete">${TRASH_SVG}</button>`;
    item.querySelector(".doc-item-body")
      .addEventListener("click", () => openPreview(d.name, d.title || d.name, "document"));
    item.querySelector(".doc-del")
      .addEventListener("click", () => deleteDocument(d.name, d.title || d.name));
    list.appendChild(item);
  });
}

async function deleteDocument(name, label) {
  if (!(await confirmDialog(`Delete document "${label}"?`,
    "This permanently removes the stored document."))) return;
  try {
    const r = await fetch(documentUrl(name), { method: "DELETE" });
    if (!r.ok && r.status !== 404) throw new Error();
    logIngest(`🗑 removed "${label}"`);
    if (currentPreview === name) closePreview();
  } catch {
    logIngest(`✕ could not delete "${label}"`, true);
  }
  loadDocuments();
}

/* =====================================================================
   FILE RENDERING — one renderer for every supported format.
   Used by both the side panel and any other surface that needs a preview.
   ===================================================================== */

// extension -> render strategy
const PREVIEW_KIND = {
  pdf: "pdf",
  html: "frame", htm: "frame",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image",
  md: "markdown", markdown: "markdown",
  txt: "text", log: "text", json: "text",
  csv: "csv", tsv: "csv",
  xlsx: "excel", xls: "excel",
  docx: "word",
};

// MIME type -> render strategy (fallback when the filename has no extension).
const MIME_KIND = {
  "application/pdf": "pdf",
  "text/html": "frame",
  "text/markdown": "markdown",
  "text/csv": "csv",
  "text/tab-separated-values": "csv",
  "application/json": "text",
  "text/plain": "text",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
  "application/vnd.ms-excel": "excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word",
};

// Decide how to render a file: prefer its real extension, fall back to MIME.
function resolveKind(filename, contentType) {
  const byExt = PREVIEW_KIND[extOf(filename)];
  if (byExt) return byExt;
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("image/")) return "image";
  return MIME_KIND[ct] || null;
}

function showLoading(container, msg) {
  container.replaceChildren();
  const d = el("div", "preview-loading");
  d.textContent = msg || "Loading…";
  container.appendChild(d);
}

async function fetchOk(url, as) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r[as]();
}

// Renders the ORIGINAL file of `name` into `container`, choosing a strategy
// from its real extension (or Content-Type). Falls back to extracted data for
// unknown types or when an office viewer library isn't loaded.
async function renderFile(container, name, origUrl, contentType, detUrl) {
  const ext = extOf(name);
  const kind = resolveKind(name, contentType);

  if (!kind) return renderExtracted(container, name, undefined, detUrl);

  if (kind === "pdf" || kind === "frame") {
    const frame = el("iframe", "preview-frame");
    frame.title = name;
    frame.src = kind === "pdf" ? `${origUrl}#view=FitH` : origUrl;
    container.replaceChildren(frame);
    return;
  }

  if (kind === "image") {
    const img = el("img", "preview-image");
    img.alt = name;
    img.src = origUrl;
    container.replaceChildren(img);
    return;
  }

  if (kind === "excel") {
    if (typeof XLSX === "undefined")
      return renderExtracted(container, name, "Spreadsheet viewer isn't loaded — showing extracted data.", detUrl);
    showLoading(container, "Reading spreadsheet…");
    const buf = await fetchOk(origUrl, "arrayBuffer");
    const wb = XLSX.read(buf, { type: "array" });
    container.replaceChildren(renderWorkbook(wb));
    enhanceCopyable(container);
    return;
  }

  if (kind === "word") {
    if (typeof mammoth === "undefined")
      return renderExtracted(container, name, "Document viewer isn't loaded — showing extracted data.", detUrl);
    showLoading(container, "Reading document…");
    const buf = await fetchOk(origUrl, "arrayBuffer");
    const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
    const doc = el("div", "preview-doc preview-doc--rich");
    doc.innerHTML = DOMPurify.sanitize(value);
    container.replaceChildren(doc);
    enhanceCopyable(doc);
    return;
  }

  // text-based formats
  showLoading(container);
  const text = await fetchOk(origUrl, "text");
  if (kind === "markdown") {
    const doc = el("div", "preview-doc");
    doc.innerHTML = renderMarkdown(text);
    container.replaceChildren(doc);
    enhanceCopyable(doc);
  } else if (kind === "csv") {
    const isTsv = ext === "tsv" || /tab-separated/.test(contentType || "");
    const doc = el("div", "preview-doc");
    doc.innerHTML = csvToTable(text, isTsv ? "\t" : ",");
    container.replaceChildren(doc);
    enhanceCopyable(doc);
  } else {
    const pre = el("pre", "preview-pre");
    pre.textContent = text;
    container.replaceChildren(pre);
  }
}

// Extracted-data fallback (the parsed YAML the agent stored).
async function renderExtracted(container, name, note, detUrl) {
  showLoading(container, note ? note : "Loading extracted data…");
  const r = await fetch(detUrl || invoiceUrl(name));
  const d = await safeJson(r);
  if (!r.ok) throw new Error(d.detail || "Not found");
  const doc = el("div", "preview-doc");
  doc.innerHTML =
    (note ? `<p class="preview-note">${escapeHtml(note)}</p>` : "") +
    renderMarkdown(d.content || "");
  container.replaceChildren(doc);
  enhanceCopyable(doc);
}

// Build a DOM node for an entire workbook, with a sheet switcher when there's
// more than one sheet. Rows are capped so a huge book can't lock the tab.
const SHEET_ROW_CAP = 1000;

function renderWorkbook(wb) {
  const wrap = el("div", "preview-doc");
  const names = wb.SheetNames.filter((n) => wb.Sheets[n]);
  if (!names.length) {
    wrap.innerHTML = `<p class="preview-note">This workbook has no sheets.</p>`;
    return wrap;
  }

  const tableFor = (sheetName) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1, blankrows: false, defval: "",
    });
    return buildHtmlTable(rows.slice(0, SHEET_ROW_CAP));
  };

  if (names.length === 1) {
    wrap.innerHTML = tableFor(names[0]);
    return wrap;
  }

  const tabs = el("div", "sheet-tabs");
  const pane = el("div", "sheet-pane");
  names.forEach((nm, i) => {
    const b = el("button", "sheet-tab" + (i === 0 ? " active" : ""));
    b.type = "button";
    b.textContent = nm;
    b.addEventListener("click", () => {
      tabs.querySelectorAll(".sheet-tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      pane.innerHTML = tableFor(nm);
      enhanceCopyable(pane);
    });
    tabs.appendChild(b);
  });
  pane.innerHTML = tableFor(names[0]);
  wrap.append(tabs, pane);
  return wrap;
}

function buildHtmlTable(rows) {
  if (!rows.length) return `<p class="preview-note">Empty sheet.</p>`;
  const head = rows[0].map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows.slice(1)
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="preview-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------- side panel (dock) ---------- */
function showDock() {
  $("#preview-dock").hidden = false;
  $("#preview-resizer").hidden = false;
}

function closePreview() {
  currentPreview = null;
  $("#preview-dock").hidden = true;
  $("#preview-resizer").hidden = true;
  $("#preview-pane").replaceChildren();
  $("#preview-tabs").replaceChildren();
}

async function openPreview(name, label, type = "invoice") {
  currentPreview = name;
  $("#preview-title").textContent = label || name;
  const tabs = $("#preview-tabs");
  const pane = $("#preview-pane");
  showDock();
  tabs.replaceChildren();
  showLoading(pane);

  const detUrl = detailUrl(name, type);
  const origUrl = previewOriginalUrl(name, type);
  const dataLabel = type === "document" ? "Document text" : "Extracted data";

  // Fetch the extracted JSON once. It feeds the data tab and, crucially, gives
  // us `source_file` — the real filename with its true extension, which the
  // stored `name` may have lost to slugifying.
  let content = "";
  let realName = name;
  try {
    const r = await fetch(detUrl);
    const d = await safeJson(r);
    if (r.ok) {
      content = d.content || "";
      const sf = /(?:^|\n)\s*source_file:\s*(.+?)\s*(?:\n|$)/.exec(content);
      if (sf) realName = sf[1].trim().replace(/^["']|["']$/g, "");
      if (!label) $("#preview-title").textContent = d.invoice_no || realName || name;
    }
  } catch {
    /* offline */
  }
  if (currentPreview !== name) return;

  // Probe the original file: does it exist, and what type does the server call it?
  let hasOrig = false;
  let contentType = "";
  try {
    const h = await fetch(origUrl, { method: "HEAD" });
    hasOrig = h.ok;
    contentType = h.headers.get("content-type") || "";
  } catch {
    /* offline */
  }
  if (currentPreview !== name) return;

  const setActive = (id) =>
    tabs.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("active", b.id === id));

  const showOriginal = async () => {
    setActive("tab-orig");
    showLoading(pane);
    try {
      await renderFile(pane, realName, origUrl, contentType, detUrl);
    } catch {
      pane.innerHTML =
        `<div class="preview-loading err">Couldn't render this file. ` +
        `<a href="${origUrl}" download>Download it instead.</a></div>`;
    }
  };

  const showData = () => {
    setActive("tab-data");
    const doc = el("div", "preview-doc");
    doc.innerHTML = renderMarkdown(content);
    pane.replaceChildren(doc);
    enhanceCopyable(doc);
  };

  if (hasOrig) {
    const t = el("button", "ptab"); t.id = "tab-orig"; t.textContent = "Original document";
    t.addEventListener("click", showOriginal);
    tabs.appendChild(t);
  }
  const td = el("button", "ptab"); td.id = "tab-data"; td.textContent = dataLabel;
  td.addEventListener("click", showData);
  tabs.appendChild(td);
  if (hasOrig) {
    const dl = el("a", "ptab ptab--dl");
    dl.href = origUrl; dl.setAttribute("download", ""); dl.textContent = "Download";
    tabs.appendChild(dl);
  }

  if (hasOrig) showOriginal();
  else showData();
}

$("#preview-close").addEventListener("click", closePreview);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#preview-dock").hidden) closePreview();
});

/* ---------- resizable splitter ---------- */
(function initResizer() {
  const panel = $(".panel--chat");
  const dock = $("#preview-dock");
  const resizer = $("#preview-resizer");

  const saved = parseFloat(localStorage.getItem(PREVIEW_WIDTH_KEY));
  if (saved) dock.style.flexBasis = saved + "px";

  let dragging = false;
  const onMove = (clientX) => {
    const rect = panel.getBoundingClientRect();
    const min = 320;
    const max = rect.width - 360; // keep at least 360px for chat
    let w = rect.right - clientX;
    w = Math.max(min, Math.min(w, Math.max(min, max)));
    dock.style.flexBasis = w + "px";
  };

  const start = (e) => {
    dragging = true;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(PREVIEW_WIDTH_KEY, parseFloat(dock.style.flexBasis) || "");
  };

  resizer.addEventListener("mousedown", start);
  window.addEventListener("mousemove", (e) => dragging && onMove(e.clientX));
  window.addEventListener("mouseup", end);
  resizer.addEventListener("touchstart", (e) => start(e.touches[0] ? e : e), { passive: false });
  window.addEventListener("touchmove", (e) => dragging && e.touches[0] && onMove(e.touches[0].clientX), { passive: false });
  window.addEventListener("touchend", end);
})();

/* ---------- upload ---------- */
const fileInput = $("#file-input");
const dropzone = $("#dropzone");

function setFileName(files) {
  const n = files?.length || 0;
  $("#dropzone-text").textContent =
    n === 0 ? "Choose file(s) or drop here" : n === 1 ? files[0].name : `${n} files selected`;
  dropzone.classList.toggle("has-file", n > 0);
}
fileInput.addEventListener("change", () => setFileName(fileInput.files));
["dragover", "dragenter"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, () => dropzone.classList.remove("drag"))
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    setFileName(fileInput.files);
  }
});

// Duplicate dialog -> resolves "replace" | "keep_both" | null (cancel).
function duplicateDialog(info) {
  return new Promise((resolve) => {
    const overlay = $("#dup-overlay");
    $("#dup-sub").textContent =
      `${info.invoice_no || "This invoice"} from ${info.seller_name || "this seller"} ` +
      `is already stored. Replace it, or keep both copies?`;
    overlay.classList.remove("hidden");
    const replace = $("#dup-replace");
    const keep = $("#dup-keep");
    const cancel = $("#dup-cancel");
    const cleanup = (val) => {
      overlay.classList.add("hidden");
      replace.removeEventListener("click", onReplace);
      keep.removeEventListener("click", onKeep);
      cancel.removeEventListener("click", onCancel);
      overlay.removeEventListener("mousedown", onBackdrop);
      resolve(val);
    };
    const onReplace = () => cleanup("replace");
    const onKeep = () => cleanup("keep_both");
    const onCancel = () => cleanup(null);
    const onBackdrop = (e) => e.target === overlay && cleanup(null);
    replace.addEventListener("click", onReplace);
    keep.addEventListener("click", onKeep);
    cancel.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onBackdrop);
    replace.focus();
  });
}

async function uploadOne(file, onDuplicate) {
  const fd = new FormData();
  fd.append("file", file);
  if (onDuplicate) fd.append("on_duplicate", onDuplicate);
  const r = await fetch("/ingest/file", { method: "POST", body: fd });
  return { status: r.status, data: await safeJson(r) };
}

// One file: interactive, so the user can resolve a duplicate.
async function uploadSingle(file) {
  let res = await uploadOne(file);
  if (res.status === 409) {
    const choice = await duplicateDialog(res.data.detail || {});
    if (!choice) {
      logIngest(`↪ skipped duplicate ${file.name}`);
      return 0;
    }
    res = await uploadOne(file, choice);
  }
  if (res.status < 200 || res.status >= 300) {
    logIngest(`✕ ${file.name}: ${res.data.detail?.message || res.data.detail || "failed"}`, true);
    return 0;
  }
  const d = res.data;
  if (d.kind === "document") {
    logIngest(`✓ document stored: ${d.title || d.name}`);
  } else {
    logIngest(`✓ ${d.invoice_no || d.name} — ${d.currency || ""} ${formatMoney(d.total_amount)}`);
  }
  return 1;
}

// Many files: extracted concurrently server-side; duplicates skipped by default.
async function uploadBulk(files) {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  logIngest(`⟳ extracting ${files.length} invoices in parallel…`);
  const r = await fetch("/ingest/files", { method: "POST", body: fd });
  const data = await safeJson(r);
  if (!r.ok) {
    logIngest(`✕ bulk upload failed: ${data.detail || r.status}`, true);
    return 0;
  }
  (data.results || []).forEach((res) => {
    if (res.status === "duplicate") logIngest(`↪ duplicate skipped: ${res.invoice_no || res.filename}`);
    else if (res.status === "error") logIngest(`✕ ${res.filename}: ${res.detail}`, true);
    else if (res.status === "stored" && res.kind === "document")
      logIngest(`✓ document stored: ${res.title || res.filename}`);
  });
  const s = data.summary;
  logIngest(`✓ ${s.stored} stored · ${s.duplicates} duplicate(s) · ${s.errors} error(s)`);
  return s.stored;
}

$("#file-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const files = Array.from(fileInput.files || []);
  if (!files.length) {
    logIngest("✕ No file selected", true);
    return;
  }
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = files.length > 1 ? `Extracting ${files.length}…` : "Extracting…";

  const stored = files.length === 1 ? await uploadSingle(files[0]) : await uploadBulk(files);

  btn.disabled = false;
  btn.textContent = "Extract & Store";
  fileInput.value = "";
  setFileName(null);
  if (stored) {
    loadInvoices();
    loadDocuments();
  }
});

/* ---------- chat ---------- */
const thread = $("#thread");

function buildEmptyStateHTML() {
  return `<div class="empty-state" id="empty-state">` +
    `<div class="empty-mark">₹</div>` +
    `<p>Ask about your invoices and finance documents — totals, tax, and charts.</p>` +
    `</div>`;
}

function clearEmptyState() {
  const empty = $("#empty-state");
  if (empty) empty.remove();
}

function resetThread() {
  sessionId = null;
  localStorage.removeItem(SESSION_KEY);
  setSessionLabel();
  thread.innerHTML = buildEmptyStateHTML();
  renderSuggestions();
}

function addMessage(role, text, chart, sources, aggregated, docSources) {
  clearEmptyState();
  const wrap = el("div", `msg msg--${role}`);

  const label = el("div", "msg-role");
  label.textContent = role === "user" ? "You" : "Agent";
  wrap.append(label);

  if (text) {
    const body = el("div", "msg-body");
    body.innerHTML = renderMarkdown(text);
    wrap.append(body);
    enhanceCopyable(body);
  }
  if (chart) wrap.append(buildChart(chart));

  // Inline source cards for the top-3 invoices the agent read (assistant only).
  if (role === "assistant" && sources && sources.length) {
    sources.slice(0, 3).forEach((name, i) => wrap.appendChild(buildSourceCard(name, i + 1)));
  }
  if (sources && sources.length) wrap.append(buildSources(sources));
  if (aggregated && aggregated.length) wrap.append(buildAggregated(aggregated));
  if (role === "assistant" && docSources && docSources.length)
    wrap.append(buildDocSources(docSources));

  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

// Preview chip for one invoice name.
function srcChip(name) {
  const chip = el("button", "src-chip");
  chip.textContent = name;
  chip.title = `Preview ${name}`;
  chip.addEventListener("click", () => openPreview(name, name));
  return chip;
}

// Specific invoices the agent read.
function buildSources(names) {
  const box = el("div", "src-chips");
  box.innerHTML = `<p class="src-label">Used:</p>`;
  names.forEach((n) => box.appendChild(srcChip(n)));
  return box;
}

// Finance documents the agent read (open the document preview, not an invoice).
function docChip(name) {
  const chip = el("button", "src-chip");
  chip.textContent = name;
  chip.title = `Preview ${name}`;
  chip.addEventListener("click", () => openPreview(name, name, "document"));
  return chip;
}
function buildDocSources(names) {
  const box = el("div", "src-chips");
  box.innerHTML = `<p class="src-label">From documents:</p>`;
  names.forEach((n) => box.appendChild(docChip(n)));
  return box;
}

// Provenance for aggregate answers: "Based on all N invoices" -> expands to chips.
function buildAggregated(names) {
  const box = el("div", "agg-sources");
  const toggle = el("button", "agg-toggle");
  toggle.textContent = `Based on all ${names.length} invoice${names.length > 1 ? "s" : ""}`;
  const list = el("div", "agg-list");
  names.forEach((n) => list.appendChild(srcChip(n)));
  toggle.addEventListener("click", () => {
    const open = list.classList.toggle("open");
    toggle.classList.toggle("open", open);
  });
  box.append(toggle, list);
  return box;
}

/* ---------- source cards (open in the side panel) ---------- */
function buildSourceCard(name, rank) {
  const box = el("div", "preview");
  const origUrl = originalUrl(name);
  box.innerHTML =
    `<div class="preview-head">` +
    `<span class="preview-label">Source ${rank}</span>` +
    `<span class="preview-name">${escapeHtml(name)}</span></div>` +
    `<div class="preview-actions">` +
    `<button type="button" class="preview-open">View</button>` +
    `<a class="preview-dl" href="${origUrl}" download>Download</a></div>`;
  box.querySelector(".preview-open").addEventListener("click", () => openPreview(name, name));
  return box;
}

// Minimal RFC-4180-ish CSV parser (handles quotes and embedded commas/newlines).
function parseCSV(text, delim) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToTable(text, delim) {
  const rows = parseCSV(text, delim).slice(0, 500); // cap for big files
  if (!rows.length) return "";
  const head = rows[0].map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const bodyRows = rows.slice(1)
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="preview-table"><thead><tr>${head}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

/* ---------- charts ---------- */
const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac",
];
function palette(n) {
  return Array.from({ length: n }, (_, i) => PALETTE[i % PALETTE.length]);
}



// Export a chart canvas as a PNG (on a white background).
function downloadChart(canvas, title) {
  const tmp = document.createElement("canvas");
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const c = tmp.getContext("2d");
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, tmp.width, tmp.height);
  c.drawImage(canvas, 0, 0);
  const a = document.createElement("a");
  a.href = tmp.toDataURL("image/png");
  a.download = (title || "chart").replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png";
  a.click();
}

function buildChart(spec) {
  const box = el("div", "chart-box");
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);

  const isPie = spec.type === "pie";
  const isBar = spec.type === "bar";
  const cats = palette(spec.values.length);
  const accent = PALETTE[0];
  const data = {
    labels: spec.labels,
    datasets: [
      {
        label: spec.title,
        data: spec.values,
        backgroundColor: isPie || isBar ? cats : "rgba(78,121,167,0.14)",
        borderColor: isPie ? "#ffffff" : accent,
        borderWidth: 2,
        fill: !isPie && !isBar,
        tension: 0.25,
        pointBackgroundColor: accent,
        pointRadius: 3,
      },
    ],
  };
  const options = {
    responsive: true,
    plugins: {
      legend: {
        display: isPie,
        position: "right",
        labels: {
          font: { family: "Inter" },
          generateLabels(chart) {
            const data = chart.data;
            const ds = data.datasets[0].data;
            const total = ds.reduce((a, b) => a + (Number(b) || 0), 0);
            return data.labels.map((label, i) => {
              const pct = total ? ((Number(ds[i]) || 0) / total) * 100 : 0;
              return {
                text: `${label} ${pct.toFixed(1)}%`,
                fillStyle: data.datasets[0].backgroundColor[i],
                strokeStyle: data.datasets[0].backgroundColor[i],
                lineWidth: 0,
                index: i,
              };
            });
          },
        },
      },
      title: { display: !!spec.title, text: spec.title, font: { family: "Inter", size: 13 } },
    },
    scales: isPie
      ? {}
      : { y: { beginAtZero: true, grid: { color: "#ececec" } }, x: { grid: { display: false } } },
  };
  new Chart(canvas.getContext("2d"), { type: spec.type, data, options });

  const dl = el("button", "chart-dl");
  dl.type = "button";
  dl.textContent = "↓ Download PNG";
  dl.addEventListener("click", () => downloadChart(canvas, spec.title));
  box.appendChild(dl);
  return box;
}

function addTyping() {
  clearEmptyState();
  const wrap = el("div", "msg msg--assistant msg-typing");
  wrap.innerHTML =
    `<div class="msg-role">Agent</div>` +
    `<div class="msg-body"><span class="dotpulse"></span><span class="dotpulse"></span><span class="dotpulse"></span></div>`;
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
  return wrap;
}

const askInput = $("#ask-input");
askInput.addEventListener("input", () => {
  askInput.style.height = "auto";
  askInput.style.height = Math.min(askInput.scrollHeight, 140) + "px";
});
askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#ask-form").requestSubmit();
  }
});

async function sendQuestion(question) {
  if (!question) return;
  hideSuggestions();
  addMessage("user", question);
  askInput.value = "";
  askInput.style.height = "auto";
  const btn = $("#ask-btn");
  btn.disabled = true;
  const typing = addTyping();
  try {
    const r = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, session_id: sessionId }),
    });
    const data = await safeJson(r);
    typing.remove();
    if (!r.ok) throw new Error(data.detail || "Request failed");
    if (data.session_id) {
      sessionId = data.session_id;
      localStorage.setItem(SESSION_KEY, sessionId);
      setSessionLabel();
    }
    addMessage("assistant", data.answer || "(no answer)", data.chart, data.sources, data.aggregated, data.doc_sources);
    loadSessions();
  } catch (err) {
    typing.remove();
    addMessage("assistant", `**Error:** ${err.message}`);
  } finally {
    btn.disabled = false;
    askInput.focus();
  }
}

$("#ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sendQuestion(askInput.value.trim());
});

/* ---------- suggestions + saved questions ---------- */
const QUESTIONS_CSV_URL = "/static/questions.csv";
const SUGGESTION_COUNT = 3;

const FALLBACK_SAMPLES = [
  "Give total tax amount from all invoices",
  "State wise sales pie chart",
  "Company growth line chart by month by sales",
];

let csvQuestions = [];

function parseQuestionsCsv(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.startsWith('"') && line.endsWith('"')
        ? line.slice(1, -1).replace(/""/g, '"')
        : line
    )
    .filter((line) => !/^questions?$/i.test(line));
}

async function loadCsvQuestions() {
  try {
    const r = await fetch(QUESTIONS_CSV_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    csvQuestions = parseQuestionsCsv(await r.text());
    if (!csvQuestions.length) throw new Error("empty");
  } catch (err) {
    console.warn(`[suggestions] questions.csv unavailable (${err.message}); using fallback samples.`);
    csvQuestions = FALLBACK_SAMPLES.slice();
  }
}

function pickRandom(arr, n) {
  const pool = arr.slice();
  const out = [];
  while (pool.length && out.length < n) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

function sampleChip(q) {
  const b = el("button", "suggestion");
  b.type = "button";
  b.textContent = q;
  b.addEventListener("click", () => {
    askInput.value = q;
    askInput.dispatchEvent(new Event("input")); // auto-grow textarea
    askInput.focus();
  });
  return b;
}

function renderSuggestions() {
  const box = $("#suggestions");
  if (!box) return;
  if (sessionId || !csvQuestions.length) {
    hideSuggestions();
    return;
  }
  box.innerHTML = "";
  const label = el("span", "suggestions-label");
  label.textContent = "Try asking";
  box.appendChild(label);
  pickRandom(csvQuestions, SUGGESTION_COUNT).forEach((q) => box.appendChild(sampleChip(q)));
  box.classList.remove("hidden");
}

function hideSuggestions() {
  const box = $("#suggestions");
  if (!box) return;
  box.classList.add("hidden");
  box.innerHTML = "";
}

const SAVED_KEY = "invoice-agent.saved";
const SYNC_SAVED_TO_SERVER = false;
const SAVE_QUESTION_ENDPOINT = "/save_question";

function getSaved() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY)) || [];
  } catch {
    return [];
  }
}
function setSaved(list) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

async function persistSavedQuestion(text) {
  if (!SYNC_SAVED_TO_SERVER) return;
  try {
    await fetch(SAVE_QUESTION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text }),
    });
  } catch {
    /* network down — localStorage already has it */
  }
}

async function saveQuestion(text) {
  text = (text || "").trim();
  if (!text) return;
  const list = getSaved();
  if (list.includes(text) || csvQuestions.includes(text)) return; // no dupes
  list.unshift(text);
  setSaved(list);
  renderSaved();
  persistSavedQuestion(text);
}
function deleteSaved(text) {
  setSaved(getSaved().filter((q) => q !== text));
  renderSaved();
}

function renderSaved() {
  const bar = $("#saved-bar");
  const saved = getSaved();
  bar.innerHTML = "";
  if (!saved.length) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  const label = el("span", "suggestions-label");
  label.textContent = "Saved";
  bar.appendChild(label);
  saved.forEach((q) => {
    const chip = el("span", "saved-chip");
    const del = el("button", "saved-x");
    del.type = "button";
    del.textContent = "×";
    del.title = "Delete saved question";
    del.addEventListener("click", () => deleteSaved(q));
    chip.append(sampleChip(q), del);
    bar.appendChild(chip);
  });
}

$("#save-q").addEventListener("click", () => {
  saveQuestion(askInput.value);
  askInput.focus();
});

/* ---------- new chat ---------- */
$("#new-chat").addEventListener("click", () => {
  resetThread();
  loadSessions();
  askInput.focus();
});

/* ---------- restore active session ---------- */
async function restoreSession() {
  if (!sessionId) {
    renderSuggestions();
    return;
  }
  try {
    const r = await fetch(`/sessions/${sessionId}/messages`);
    if (!r.ok) {
      localStorage.removeItem(SESSION_KEY);
      sessionId = null;
      renderSuggestions();
      return;
    }
    const msgs = await r.json();
    if (msgs.length) {
      clearEmptyState();
      hideSuggestions();
    } else {
      renderSuggestions();
    }
    msgs.forEach((m) => addMessage(m.role, m.content, m.chart, m.sources, m.aggregated, m.doc_sources));
  } catch {
    /* offline */
  }
}

/* ---------- copy / excel action buttons ---------- */
function enhanceCopyable(container) {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.dataset.enhanced) return;
    pre.dataset.enhanced = "1";
    const wrap = el("div", "copy-wrap");
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    wrap.appendChild(
      makeActionBtn("Copy", "Copied", async () => {
        await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText);
      })
    );
  });

  container.querySelectorAll("table").forEach((table) => {
    if (table.dataset.enhanced) return;
    table.dataset.enhanced = "1";
    const wrap = el("div", "copy-wrap copy-wrap--table");
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
    wrap.appendChild(
      makeActionBtn("Excel", "Saved", async () => {
        downloadCSV(tableToCSV(table), `table-${Date.now()}.csv`);
      })
    );
  });
}

function makeActionBtn(label, doneLabel, action) {
  const btn = el("button", "copy-btn");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await action();
      btn.textContent = doneLabel;
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("copied");
      }, 1400);
    } catch {
      btn.textContent = "Failed";
      setTimeout(() => (btn.textContent = label), 1400);
    }
  });
  return btn;
}

function tableToCSV(table) {
  const escape = (s) => {
    s = String(s).replace(/\r?\n/g, " ");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Array.from(table.rows)
    .map((row) => Array.from(row.cells).map((c) => escape(c.innerText.trim())).join(","))
    .join("\r\n");
}

function downloadCSV(csv, filename) {
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- init ---------- */
async function init() {
  setSessionLabel();
  await loadCsvQuestions();
  renderSaved();
  await restoreSession();
  loadSessions();
  loadInvoices();
  loadDocuments();
  ping();
  setInterval(ping, 15000);
}

async function boot() {
  const token = sessionStorage.getItem(AUTH_KEY);
  if (token && (await checkAuth(token))) {
    // Refresh the cookie so browser-native requests (previews/downloads) stay
    // authenticated after a page reload, not just right after login.
    document.cookie = `fa_auth=${token}; path=/; max-age=86400; SameSite=Strict`;
    showApp();
    init();
  } else {
    sessionStorage.removeItem(AUTH_KEY);
    document.cookie = "fa_auth=; path=/; max-age=0; SameSite=Strict";
    showLogin();
  }
}
boot();