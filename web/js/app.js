"use strict";

/* $, el, escapeHtml, safeJson, confirmDialog, toast, theme, cssVar, and the
   auth token helpers (storeToken/clearToken/getToken) + fetch wrapper all
   come from core.js, loaded before this file. */

const SESSION_KEY = "invoice-agent.session";
const PREVIEW_WIDTH_KEY = "invoice-agent.previewWidth";

let sessionId = localStorage.getItem(SESSION_KEY) || null;
let currentPreview = null; // name of the invoice currently shown in the dock

/* ---------- auth (per-user login, JWT) ---------- */
const AGENT_KEY = "invoice-agent.agentId";

let currentUser = null;
let agents = [];
let agentId = localStorage.getItem(AGENT_KEY) || null;

/* Every data/chat route is scoped to the selected agent. */
function api(path) {
  if (!agentId) throw new Error("No agent selected");
  return `/agents/${encodeURIComponent(agentId)}${path}`;
}

/* Confirm the stored token is still valid and load who the user is plus the
   agents they are allowed to use. */
async function loadMe() {
  const r = await fetch("/auth/me");
  if (!r.ok) return false;
  const data = await r.json();
  applyIdentity(data.user, data.agents);
  return true;
}

function applyIdentity(user, list) {
  currentUser = user;
  agents = list || [];
  sessionStorage.setItem(AUTH_USER_KEY, user.username);
  // Keep the previously selected agent if it is still granted.
  if (!agents.some((a) => a.id === agentId)) agentId = agents[0] ? agents[0].id : null;
  if (agentId) localStorage.setItem(AGENT_KEY, agentId);
}

/* Re-fetch identity and react if what this user can access changed under
   them — an admin revoking a grant or deactivating an agent mid-session.
   Called immediately on a 403 (unambiguous access denial) and on a timer
   (to catch an agent disappearing entirely, which surfaces as a 404 that
   would be indistinguishable from a routine "invoice not found" if handled
   generically). */
let syncingIdentity = false;
async function syncIdentity() {
  if (syncingIdentity) return;
  syncingIdentity = true;
  try {
    const had = agentId;
    const hadIds = agents.map((a) => a.id).sort().join(",");
    const r = await fetch("/auth/me");
    if (!r.ok) return; // a 401 here already triggers onUnauthorized via the fetch wrapper
    const data = await r.json();
    applyIdentity(data.user, data.agents);
    const nowIds = agents.map((a) => a.id).sort().join(",");
    if (nowIds === hadIds) return; // nothing actually changed
    const lostCurrent = had && !agents.some((a) => a.id === had);
    toast(
      lostCurrent ? "You no longer have access to that agent." : "Your available agents changed.",
      { variant: lostCurrent ? "danger" : "info" }
    );
    if (lostCurrent) closePreview();
    renderAgentChip();
    await init();
  } catch {
    /* offline — leave things as they are */
  } finally {
    syncingIdentity = false;
  }
}

function showApp() {
  $("#boot-splash").classList.add("hidden");
  $("#login-overlay").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  const username = sessionStorage.getItem(AUTH_USER_KEY) || "";
  $("#profile-name").textContent = username || "Account";
  $("#profile-avatar").textContent = username.slice(0, 2) || "?";
  $("#admin-link").classList.toggle("hidden", !currentUser || currentUser.role !== "admin");
  renderAgentChip();
}

// The role now shows as a badge next to the name; the sub-line — "Signed
// in" before, then a bare "USER"/"ADMIN" after multi-agent — does something
// more useful: how many agents this account can actually reach.
function renderProfileCard() {
  const isAdmin = currentUser && currentUser.role === "admin";
  $("#profile-badge").textContent = "Admin";
  $("#profile-badge").classList.toggle("hidden", !isAdmin);
  $("#profile-role").textContent = agents.length
    ? `${agents.length} agent${agents.length === 1 ? "" : "s"}`
    : "No agents";
}

function showLogin() {
  $("#boot-splash").classList.add("hidden");
  $("#app-shell").classList.add("hidden");
  $("#login-overlay").classList.remove("hidden");
  $("#profile-menu").classList.add("hidden");
}

setAuthHandlers({ onUnauthorized: showLogin, onAccessChanged: syncIdentity });

/* ---------- agent switcher (masthead chip + dropdown panel) ---------- */
let agentStatsCache = {}; // agentId -> {invoices, documents} | "loading"
let switcherFocusIndex = -1;

function agentMonogram(name) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "—";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function renderAgentChip() {
  const chip = $("#agent-chip");
  const active = agents.find((a) => a.id === agentId);
  chip.classList.toggle("agent-chip--empty", !active);
  $("#agent-chip-mark").textContent = active ? agentMonogram(active.name) : "—";
  $("#agent-chip-name").textContent = active ? active.name : "No agent";
  chip.title = (active && active.description) || "";
  renderNoAgentWorkspace();
  renderProfileCard();
}

/* R2: a user with zero granted agents gets a real disabled state — not a
   fully-interactive UI that quietly 404s every request against
   /agents/null/... */
function renderNoAgentWorkspace() {
  const isEmpty = agents.length === 0;
  $("#app-layout").classList.toggle("layout--no-agent", isEmpty);
  $("#chat-main").classList.toggle("chat-main--empty", isEmpty);
  $("#no-agent-state").classList.toggle("hidden", !isEmpty);
  $("#new-chat").disabled = isEmpty;
  fileInput.disabled = isEmpty;
  $("#ask-input").disabled = isEmpty;
  $("#ask-btn").disabled = isEmpty;
  $("#save-q").disabled = isEmpty;
  if (isEmpty) {
    const isAdmin = currentUser && currentUser.role === "admin";
    $("#no-agent-text").textContent = isAdmin
      ? "Create an agent in the admin console to get started."
      : "Ask your administrator for access to an agent.";
    $("#no-agent-cta").classList.toggle("hidden", !isAdmin);
  }
}

function statsLabel(stats) {
  if (!stats) return "";
  if (stats === "loading") return "Loading…";
  return (
    `${stats.invoices} invoice${stats.invoices === 1 ? "" : "s"} · ` +
    `${stats.documents} document${stats.documents === 1 ? "" : "s"}`
  );
}

// Fetched lazily, only for the active agent — never for every row, since
// computing this on the server reads every invoice/document file on disk.
async function fetchAgentStats(id) {
  agentStatsCache[id] = "loading";
  try {
    const r = await fetch(`/agents/${encodeURIComponent(id)}/stats`);
    if (!r.ok) {
      delete agentStatsCache[id];
      return;
    }
    agentStatsCache[id] = await r.json();
  } catch {
    delete agentStatsCache[id];
    return;
  }
  const span = document.querySelector(`[data-stats-for="${id}"]`);
  if (span) span.textContent = statsLabel(agentStatsCache[id]);
}

function renderAgentSwitcherList() {
  const list = $("#agent-switcher-list");
  const empty = $("#agent-switcher-empty");
  const manage = $("#agent-switcher-manage");
  list.innerHTML = "";
  list.classList.toggle("hidden", agents.length === 0);
  empty.classList.toggle("hidden", agents.length > 0);
  manage.classList.toggle("hidden", !(currentUser && currentUser.role === "admin"));

  agents.forEach((a) => {
    const isActive = a.id === agentId;
    const row = el("button", "agent-row" + (isActive ? " active" : ""));
    row.type = "button";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(isActive));
    row.dataset.id = a.id;
    row.innerHTML =
      `<span class="agent-row-mark">${escapeHtml(agentMonogram(a.name))}</span>` +
      `<span class="agent-row-body">` +
      `<span class="agent-row-name">${escapeHtml(a.name)}` +
      (isActive ? `<span class="agent-row-active-badge">Active</span>` : "") +
      `</span>` +
      (a.description ? `<span class="agent-row-desc">${escapeHtml(a.description)}</span>` : "") +
      `<span class="agent-row-stats" data-stats-for="${a.id}">${statsLabel(agentStatsCache[a.id])}</span>` +
      `</span>`;
    row.addEventListener("click", () => {
      closeAgentSwitcher();
      switchAgent(a.id);
    });
    list.appendChild(row);
  });

  if (agentId && !agentStatsCache[agentId]) fetchAgentStats(agentId);
}

function isSwitcherOpen() {
  return !$("#agent-switcher").classList.contains("hidden");
}
function focusSwitcherRow() {
  const rows = $$(".agent-row");
  rows.forEach((r, i) => r.classList.toggle("focused", i === switcherFocusIndex));
  if (rows[switcherFocusIndex]) rows[switcherFocusIndex].scrollIntoView({ block: "nearest" });
}
function onSwitcherKey(e) {
  const rows = $$(".agent-row");
  if (e.key === "Escape") {
    closeAgentSwitcher();
    $("#agent-chip").focus();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    switcherFocusIndex = Math.min(switcherFocusIndex + 1, rows.length - 1);
    focusSwitcherRow();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    switcherFocusIndex = Math.max(switcherFocusIndex - 1, 0);
    focusSwitcherRow();
  } else if (e.key === "Home") {
    e.preventDefault();
    switcherFocusIndex = 0;
    focusSwitcherRow();
  } else if (e.key === "End") {
    e.preventDefault();
    switcherFocusIndex = rows.length - 1;
    focusSwitcherRow();
  } else if (e.key === "Enter" && rows[switcherFocusIndex]) {
    e.preventDefault();
    const id = rows[switcherFocusIndex].dataset.id;
    closeAgentSwitcher();
    switchAgent(id);
  }
}
function openAgentSwitcher() {
  renderAgentSwitcherList();
  $("#agent-switcher").classList.remove("hidden");
  $("#agent-chip").setAttribute("aria-expanded", "true");
  switcherFocusIndex = agents.findIndex((a) => a.id === agentId);
  focusSwitcherRow();
  document.addEventListener("keydown", onSwitcherKey);
}
function closeAgentSwitcher() {
  $("#agent-switcher").classList.add("hidden");
  $("#agent-chip").setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onSwitcherKey);
}

$("#agent-chip").addEventListener("click", (e) => {
  e.stopPropagation();
  if (isSwitcherOpen()) closeAgentSwitcher();
  else openAgentSwitcher();
});
document.addEventListener("click", (e) => {
  if (isSwitcherOpen() && !$(".masthead-center").contains(e.target)) closeAgentSwitcher();
});

/* ---------- theme toggle ---------- */
$("#theme-toggle").title = `Theme: ${theme.get()}`;
$("#theme-toggle").addEventListener("click", () => {
  $("#theme-toggle").title = `Theme: ${theme.cycle()}`;
});

/* Switching agent swaps the whole workspace: its data, its conversations. */
async function switchAgent(id) {
  if (!id || id === agentId) return;
  agentId = id;
  localStorage.setItem(AGENT_KEY, id);
  sessionId = null;
  localStorage.removeItem(SESSION_KEY);
  resetThread();
  // The preview dock, ingest log and pending file selection all belong to
  // the agent being left — carrying them into the new one would silently
  // show/act on the wrong agent's data.
  closePreview();
  $("#ingest-log").innerHTML = "";
  $("#ingest-log-head").classList.add("hidden");
  fileInput.value = "";
  setFileName(null);
  renderAgentChip();
  await init();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("#login-submit");
  submit.disabled = true;
  $("#login-error").classList.add("hidden");
  try {
    const r = await rawFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("#login-username").value,
        password: $("#login-password").value,
      }),
    });
    if (!r.ok) throw new Error("bad credentials");
    const data = await r.json();
    storeToken(data.access_token);
    applyIdentity(data.user, data.agents);
    showApp();
    init();
    setInterval(ping, 15000);
    setInterval(syncIdentity, 60000);
  } catch {
    $("#login-error").classList.remove("hidden");
  } finally {
    submit.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", () => {
  clearToken();
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
function toggleHistoryPanel() {
  const collapsed = $("#history-panel").classList.toggle("collapsed");
  $("#app-layout").classList.toggle("history-collapsed", collapsed);
  $("#history-toggle").setAttribute("aria-expanded", String(!collapsed));
}
$("#history-toggle").addEventListener("click", toggleHistoryPanel);

/* ---------- helpers ---------- */
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

function logIngest(message, isError) {
  $("#ingest-log-head").classList.remove("hidden");
  const item = el("div", "log-item" + (isError ? " err" : ""));
  item.textContent = message;
  const log = $("#ingest-log");
  log.prepend(item);
  while (log.children.length > 8) log.lastChild.remove();
}

/* ---------- per-file upload progress rows ---------- */
function ingestRowEl(filename) {
  $("#ingest-log-head").classList.remove("hidden");
  const row = el("div", "ingest-row");
  row.innerHTML =
    `<span class="ingest-row-name">${escapeHtml(filename)}</span>` +
    `<span class="ingest-row-state ingest-row-state--queued">QUEUED</span>` +
    `<span class="ingest-row-bar"><span class="ingest-row-bar-fill"></span></span>`;
  $("#ingest-log").prepend(row);
  return row;
}

// state: queued | extracting | stored | duplicate | error. The progress rule
// (the thin animated bar) shows only while the file is still in flight, and
// error rows are never auto-trimmed — they wait for "Clear".
function setIngestRow(row, state, detail) {
  const chip = row.querySelector(".ingest-row-state");
  chip.textContent = state.toUpperCase();
  chip.className = `ingest-row-state ingest-row-state--${state}`;
  if (detail) {
    let d = row.querySelector(".ingest-row-detail");
    if (!d) {
      d = el("span", "ingest-row-detail");
      row.insertBefore(d, chip);
    }
    d.textContent = detail;
  }
  const bar = row.querySelector(".ingest-row-bar");
  if (bar && state !== "queued" && state !== "extracting") bar.remove();
}

$("#ingest-clear").addEventListener("click", () => {
  $("#ingest-log").innerHTML = "";
  $("#ingest-log-head").classList.add("hidden");
});

// D4: the heading is the conversation's own title (truncated one line); the
// sub-line names the active agent, since that's the thing a hex session id
// never actually told the user.
let currentSessionTitle = null;

function setSessionLabel() {
  const active = agents.find((a) => a.id === agentId);
  $("#session-label").textContent = active ? `Active agent · ${active.name}` : "No agent selected";
  $("#chat-title").textContent = sessionId && currentSessionTitle ? currentSessionTitle : "New conversation";
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
  return api(`/invoices/${encodeURIComponent(name)}`);
}
function originalUrl(name) {
  return `${invoiceUrl(name)}/original`;
}
function documentUrl(name) {
  return api(`/documents/${encodeURIComponent(name)}`);
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
  const text = $("#status-text");
  try {
    const r = await fetch("/health");
    dot.className = r.ok ? "dot online" : "dot offline";
    dot.title = r.ok ? "online" : "offline";
    if (text) text.textContent = r.ok ? "ONLINE" : "OFFLINE";
  } catch {
    dot.className = "dot offline";
    dot.title = "offline";
    if (text) text.textContent = "OFFLINE";
  }
}

/* ---------- session history sidebar ---------- */
let sessionsCache = {}; // session_id -> title, refreshed on every loadSessions()

async function loadSessions() {
  const list = $("#session-list");
  skeletonRows(list, 3);
  let sessions = [];
  try {
    const r = await fetch(api("/sessions"));
    if (r.ok) sessions = await r.json();
  } catch {
    return;
  }
  if (!sessions.length) {
    list.innerHTML = `<p class="session-empty">No conversations yet.</p>`;
    return;
  }
  list.innerHTML = "";
  let titleChanged = false;
  sessions.forEach((s) => {
    sessionsCache[s.session_id] = s.title;
    if (s.session_id === sessionId && currentSessionTitle !== s.title) {
      currentSessionTitle = s.title;
      titleChanged = true;
    }
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
  if (titleChanged) setSessionLabel();
}

async function switchSession(id) {
  if (id === sessionId) return;
  hideSuggestions();
  sessionId = id;
  localStorage.setItem(SESSION_KEY, id);
  currentSessionTitle = sessionsCache[id] || null;
  setSessionLabel();
  thread.innerHTML = "";
  await loadMessages(id);
  loadSessions();
}

async function loadMessages(id) {
  try {
    const r = await fetch(api(`/sessions/${id}/messages`));
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
    const r = await fetch(api(`/sessions/${id}`), { method: "DELETE" });
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

let invoicesCache = [];
let documentsCache = [];

async function loadInvoices() {
  const list = $("#inv-list");
  skeletonRows(list, 3);
  let invs = [];
  try {
    const r = await fetch(api("/invoices"));
    if (r.ok) invs = await r.json();
  } catch {
    return;
  }
  invoicesCache = invs;
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
  skeletonRows(list, 2);
  let docs = [];
  try {
    const r = await fetch(api("/documents"));
    if (r.ok) docs = await r.json();
  } catch {
    return;
  }
  documentsCache = docs;
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
// Highest Escape priority: dock -> palette -> shortcuts sheet (registerEscapable, core.js).
registerEscapable(() => !$("#preview-dock").hidden, closePreview, 30);

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
  const r = await fetch(api("/ingest/file"), { method: "POST", body: fd });
  return { status: r.status, data: await safeJson(r) };
}

// One file: interactive, so the user can resolve a duplicate.
async function uploadSingle(file) {
  const row = ingestRowEl(file.name);
  setIngestRow(row, "extracting");
  let res = await uploadOne(file);
  if (res.status === 409) {
    const choice = await duplicateDialog(res.data.detail || {});
    if (!choice) {
      setIngestRow(row, "duplicate", "skipped");
      return 0;
    }
    setIngestRow(row, "extracting");
    res = await uploadOne(file, choice);
  }
  if (res.status < 200 || res.status >= 300) {
    setIngestRow(row, "error", res.data.detail?.message || res.data.detail || "failed");
    return 0;
  }
  const d = res.data;
  if (d.kind === "document") {
    setIngestRow(row, "stored", d.title || d.name);
  } else {
    setIngestRow(row, "stored", `${d.currency || ""} ${formatMoney(d.total_amount)}`.trim());
  }
  return 1;
}

// Many files: extracted concurrently server-side; duplicates skipped by
// default. The backend resolves the whole batch at once (no streamed
// progress), so every row shows EXTRACTING until the batch response lands,
// then each flips to its own final state.
async function uploadBulk(files) {
  const rows = new Map(files.map((f) => [f.name, ingestRowEl(f.name)]));
  rows.forEach((row) => setIngestRow(row, "extracting"));

  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  const r = await fetch(api("/ingest/files"), { method: "POST", body: fd });
  const data = await safeJson(r);
  if (!r.ok) {
    rows.forEach((row) => setIngestRow(row, "error", data.detail || `HTTP ${r.status}`));
    return 0;
  }
  (data.results || []).forEach((res) => {
    const row = rows.get(res.filename);
    if (!row) return;
    if (res.status === "duplicate") setIngestRow(row, "duplicate", res.invoice_no || "");
    else if (res.status === "error") setIngestRow(row, "error", res.detail);
    else if (res.status === "stored" && res.kind === "document") setIngestRow(row, "stored", res.title || "");
    else if (res.status === "stored") setIngestRow(row, "stored", res.invoice_no || "");
  });
  return data.summary.stored;
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
  currentSessionTitle = null;
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

  // Read theme-aware colors at render time so a chart drawn in dark mode
  // isn't stuck with light-mode grid/text/pie-border colors baked in.
  const gridColor = cssVar("--chart-grid", "#ececec");
  const textColor = cssVar("--chart-text", "#6b6b6b");
  const pieBorder = cssVar("--chart-pie-border", "#ffffff");

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
        borderColor: isPie ? pieBorder : accent,
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
          color: textColor,
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
      title: {
        display: !!spec.title,
        text: spec.title,
        font: { family: "Inter", size: 13 },
        color: textColor,
      },
    },
    scales: isPie
      ? {}
      : {
          y: {
            beginAtZero: true,
            grid: { color: gridColor },
            ticks: { color: textColor },
          },
          x: {
            grid: { display: false },
            ticks: { color: textColor },
          },
        },
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
  // Enter sends (Shift+Enter makes a newline); Ctrl/Cmd+Enter always sends
  // too, for anyone used to that convention from other composers.
  if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    $("#ask-form").requestSubmit();
  }
});

async function sendQuestion(question) {
  if (!question) return;
  const wasNewSession = !sessionId;
  hideSuggestions();
  addMessage("user", question);
  askInput.value = "";
  askInput.style.height = "auto";
  const btn = $("#ask-btn");
  btn.disabled = true;
  const typing = addTyping();
  try {
    const r = await fetch(api("/ask"), {
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
      // Mirrors how the backend derives a session's title (its first user
      // message) so the heading is right immediately, with no extra fetch.
      if (wasNewSession) {
        currentSessionTitle = question.length > 80 ? question.slice(0, 80) + "…" : question;
        sessionsCache[sessionId] = currentSessionTitle;
      }
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
const SUGGESTION_COUNT = 3;

// Used only if the agent's own suggestions can't be fetched at all (offline,
// server error) — the server itself falls back to the same finance defaults
// when an agent has no admin-configured list (see DEFAULT_SUGGESTIONS,
// app/agent.py).
const FALLBACK_SAMPLES = [
  "Give total tax amount from all invoices",
  "State wise sales pie chart",
  "Company growth line chart by month by sales",
];

let agentQuestions = [];
let suggestionsCache = {}; // agentId -> questions[] — fetched once per agent per session (R16)

async function loadSuggestions() {
  if (suggestionsCache[agentId]) {
    agentQuestions = suggestionsCache[agentId];
    return;
  }
  try {
    const r = await fetch(api("/suggestions"));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    agentQuestions =
      Array.isArray(data.questions) && data.questions.length
        ? data.questions
        : FALLBACK_SAMPLES.slice();
  } catch (err) {
    console.warn(`[suggestions] unavailable (${err.message}); using fallback samples.`);
    agentQuestions = FALLBACK_SAMPLES.slice();
  }
  suggestionsCache[agentId] = agentQuestions;
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
  if (sessionId || !agentQuestions.length) {
    hideSuggestions();
    return;
  }
  box.innerHTML = "";
  const label = el("span", "suggestions-label");
  label.textContent = "Try asking";
  box.appendChild(label);
  pickRandom(agentQuestions, SUGGESTION_COUNT).forEach((q) => box.appendChild(sampleChip(q)));
  box.classList.remove("hidden");
}

function hideSuggestions() {
  const box = $("#suggestions");
  if (!box) return;
  box.classList.add("hidden");
  box.innerHTML = "";
}

// Namespaced per user + agent, so saved questions never leak between
// accounts on a shared browser and each agent gets its own list.
const SAVED_KEY_LEGACY = "invoice-agent.saved"; // pre-multi-agent: one global list
const SYNC_SAVED_TO_SERVER = false;
const SAVE_QUESTION_ENDPOINT = "/save_question";

function savedKey() {
  const user = sessionStorage.getItem(AUTH_USER_KEY) || "anon";
  return `${SAVED_KEY_LEGACY}.${user}.${agentId || "none"}`;
}

// One-time migration: adopt the old global list into this user+agent's
// namespaced key, then remove it so it can't leak to anyone else.
function migrateLegacySaved() {
  try {
    const legacy = localStorage.getItem(SAVED_KEY_LEGACY);
    if (legacy == null) return;
    const key = savedKey();
    if (localStorage.getItem(key) == null) localStorage.setItem(key, legacy);
    localStorage.removeItem(SAVED_KEY_LEGACY);
  } catch {
    /* storage unavailable — nothing to migrate */
  }
}

function getSaved() {
  try {
    return JSON.parse(localStorage.getItem(savedKey())) || [];
  } catch {
    return [];
  }
}
function setSaved(list) {
  localStorage.setItem(savedKey(), JSON.stringify(list));
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
  if (list.includes(text) || agentQuestions.includes(text)) return; // no dupes
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
    const r = await fetch(api(`/sessions/${sessionId}/messages`));
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

/* ---------- command palette + shortcuts ----------
   Built entirely from state already loaded for the visible page — no fetch
   fires when the palette opens or as you type (core.js's renderPaletteRows
   just filters this list client-side). */
function buildPaletteActions() {
  const actions = [];

  agents.forEach((a) => {
    if (a.id === agentId) return; // already active
    actions.push({
      group: "Switch agent",
      label: a.name,
      hint: a.description || "",
      action: () => switchAgent(a.id),
    });
  });

  actions.push({
    group: "Chat",
    label: "New conversation",
    action: () => {
      resetThread();
      loadSessions();
      askInput.focus();
    },
  });

  Object.entries(sessionsCache)
    .slice(0, 20)
    .forEach(([id, title]) => {
      if (id === sessionId) return;
      actions.push({
        group: "Conversations",
        label: title || "Untitled conversation",
        action: () => switchSession(id),
      });
    });

  invoicesCache.slice(0, 30).forEach((d) => {
    actions.push({
      group: "Invoices",
      label: d.invoice_no || d.name,
      hint: d.buyer_state || "",
      action: () => openPreview(d.name, d.invoice_no || d.name),
    });
  });

  documentsCache.slice(0, 30).forEach((d) => {
    actions.push({
      group: "Documents",
      label: d.title || d.name,
      action: () => openPreview(d.name, d.title || d.name, "document"),
    });
  });

  actions.push({ group: "View", label: "Toggle sidebar", hint: "Ctrl/Cmd+B", action: toggleHistoryPanel });
  actions.push({
    group: "View",
    label: `Cycle theme (currently ${theme.get()})`,
    hint: "light · dark · system",
    action: () => {
      $("#theme-toggle").title = `Theme: ${theme.cycle()}`;
    },
  });

  if (currentUser && currentUser.role === "admin") {
    actions.push({ group: "Admin", label: "Open admin console", action: () => (location.href = "/admin") });
  }
  actions.push({ group: "Account", label: "Log out", action: () => { clearToken(); location.reload(); } });

  return actions;
}
setPaletteActions(buildPaletteActions);

function buildShortcutsList() {
  return [
    ["Command palette", [MOD_KEY, "K"]],
    ["Shortcuts (this sheet)", [MOD_KEY, "/"]],
    ["Send question", ["Enter"]],
    ["New line in composer", ["Shift", "Enter"]],
    ["Toggle sidebar", [MOD_KEY, "B"]],
    ["Close preview / palette / sheet", ["Esc"]],
  ];
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleHistoryPanel();
  }
});

/* ---------- init ---------- */
async function init() {
  setSessionLabel();
  ping();
  if (!agentId) return; // user has no agent granted — nothing to load
  migrateLegacySaved();
  await loadSuggestions();
  renderSaved();
  await restoreSession();
  loadSessions();
  loadInvoices();
  loadDocuments();
}

async function boot() {
  const token = getToken();
  if (!token) {
    // Nothing to verify — go straight to the login gate, no splash needed.
    showLogin();
    return;
  }
  // A token exists: hold on the boot splash (never the login modal) while it
  // is verified, so a returning signed-in user never sees a login flash.
  $("#boot-splash").classList.remove("hidden");
  const ok = await loadMe();
  if (ok) {
    // Refresh the cookie so browser-native requests (previews/downloads) stay
    // authenticated after a page reload, not just right after login.
    storeToken(token);
    showApp();
    init();
    setInterval(ping, 15000);
    setInterval(syncIdentity, 60000);
  } else {
    clearToken();
    showLogin();
  }
}
boot();