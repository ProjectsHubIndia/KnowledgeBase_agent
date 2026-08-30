"use strict";

/* Shared by both index.html and admin.js: DOM helpers, the auth fetch
   wrapper, the confirm dialog, toasts, and the theme switch. Loaded before
   app.js / admin.js on both pages — everything here is a plain global,
   matching the rest of this codebase (no bundler, no modules). */

/* ---------- DOM helpers ---------- */
function $(sel) {
  return document.querySelector(sel);
}
function $$(sel) {
  return Array.from(document.querySelectorAll(sel));
}
function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
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

/* ---------- auth token storage ---------- */
const AUTH_KEY = "invoice-agent.token"; // sessionStorage: the JWT
const AUTH_USER_KEY = "invoice-agent.authUser";

function getToken() {
  return sessionStorage.getItem(AUTH_KEY);
}

function storeToken(token) {
  sessionStorage.setItem(AUTH_KEY, token);
  // Also mirrored into a cookie so browser-native requests (iframe/img src,
  // download links like /original) are authenticated — those can't carry
  // the Authorization header the fetch wrapper below adds.
  document.cookie = `fa_auth=${token}; path=/; max-age=86400; SameSite=Strict`;
}

function clearToken() {
  sessionStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_USER_KEY);
  document.cookie = "fa_auth=; path=/; max-age=0; SameSite=Strict";
}

/* ---------- shared fetch wrapper ----------
   Attaches the bearer token to every request, and reacts to the two auth
   failure shapes the backend can hand back:
   - 401 -> the token is gone or expired. Clear it and hand control to
     whatever the page registered as its "go to the login gate" handler.
   - 403 -> the caller is authenticated but was refused (require_admin, or
     agent_access when a grant was revoked / an agent was deactivated).
     This is unambiguous, unlike a 404 (which also fires for perfectly
     routine "that invoice/session doesn't exist" cases) — so only 403
     triggers an identity re-check, never a blanket 404 handler. */
let authHandlers = { onUnauthorized: () => {}, onAccessChanged: () => {} };
function setAuthHandlers(handlers) {
  authHandlers = { ...authHandlers, ...handlers };
}

const rawFetch = window.fetch.bind(window);
window.fetch = (input, opts = {}) => {
  const token = getToken();
  if (!token) return rawFetch(input, opts);
  const headers = new Headers(opts.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return rawFetch(input, { ...opts, headers }).then((r) => {
    if (r.status === 401) {
      clearToken();
      authHandlers.onUnauthorized();
    } else if (r.status === 403) {
      authHandlers.onAccessChanged();
    }
    return r;
  });
};

/* ---------- confirmation modal ----------
   Shared by both pages. Requires #confirm-overlay / #confirm-text /
   #confirm-sub / #confirm-ok / #confirm-cancel (+ the optional checkbox row)
   to exist in the page — both index.html and admin.html carry this markup.

   confirmDialogEx resolves {ok, checked} and optionally shows one checkbox
   (used by the admin console's "also delete files on disk" purge option).
   confirmDialog is the plain boolean form every other call site uses. */
function confirmDialogEx(text, sub, opts = {}) {
  return new Promise((resolve) => {
    const overlay = $("#confirm-overlay");
    $("#confirm-text").textContent = text;
    $("#confirm-sub").textContent = sub || "This cannot be undone.";
    const cbRow = $("#confirm-checkbox-row");
    const cb = $("#confirm-checkbox");
    if (opts.checkboxLabel && cbRow && cb) {
      $("#confirm-checkbox-label").textContent = opts.checkboxLabel;
      cb.checked = false;
      cbRow.classList.remove("hidden");
    } else if (cbRow) {
      cbRow.classList.add("hidden");
    }
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
    const onOk = () => cleanup({ ok: true, checked: !!(cb && cb.checked) });
    const onCancel = () => cleanup({ ok: false, checked: false });
    const onBackdrop = (e) => e.target === overlay && cleanup({ ok: false, checked: false });
    const onKey = (e) => {
      if (e.key === "Escape") cleanup({ ok: false, checked: false });
      // Enter inside the checkbox itself just toggles it, not confirm.
      if (e.key === "Enter" && document.activeElement !== cb) {
        cleanup({ ok: true, checked: !!(cb && cb.checked) });
      }
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    overlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

function confirmDialog(text, sub) {
  return confirmDialogEx(text, sub).then((r) => r.ok);
}

/* ---------- toasts ----------
   One stack, bottom-right, square, auto-dismissing. Used for cross-cutting
   events that aren't tied to a specific form (access revoked, session
   expired) rather than for routine per-action feedback. */
function toast(message, opts = {}) {
  const stack = $("#toast-stack");
  if (!stack) return; // page hasn't got a stack (shouldn't happen, but don't crash)
  const variant = opts.variant || "info"; // info | danger
  const duration = opts.duration ?? 5000;
  const node = el("div", `toast toast--${variant}`);
  node.setAttribute("role", "status");
  const msg = el("span", "toast-msg");
  msg.textContent = message;
  const close = el("button", "toast-close");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  node.append(msg, close);
  stack.appendChild(node);
  let timer = duration > 0 ? setTimeout(dismiss, duration) : null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    node.classList.add("toast--leaving");
    setTimeout(() => node.remove(), 160);
  }
  close.addEventListener("click", dismiss);
  return dismiss;
}

/* ---------- theme ----------
   light | dark | system, persisted, applied as data-theme on <html>.
   The inline <head> script in both pages already applies the stored choice
   before first paint (same storage key) — this module is what the toggle UI
   calls, and what re-applies it here so both stay in sync. */
const THEME_KEY = "invoice-agent.theme";

const theme = {
  get() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === "dark" || t === "light" ? t : "system";
    } catch {
      return "system";
    }
  },
  set(value) {
    try {
      if (value === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, value);
    } catch {
      /* storage unavailable — still apply for this page view */
    }
    theme.apply();
  },
  apply() {
    const v = theme.get();
    if (v === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", v);
  },
  effective() {
    const v = theme.get();
    if (v !== "system") return v;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  },
  cycle() {
    const order = ["system", "light", "dark"];
    theme.set(order[(order.indexOf(theme.get()) + 1) % order.length]);
    return theme.get();
  },
};
theme.apply();

/* Read a CSS custom property's current computed value (theme-aware), used by
   Chart.js which needs literal color strings rather than var(...). */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback || "";
}

/* ---------- skeleton loaders ----------
   Shimmer placeholder rows shown while a list is loading, so a slow fetch
   isn't indistinguishable from a genuinely empty list. */
function skeletonRows(container, n = 3) {
  container.innerHTML = "";
  for (let i = 0; i < n; i++) container.appendChild(el("div", "skeleton-row"));
}

/* ---------- ordered Escape handling ----------
   Several overlays can theoretically be open at once (the preview dock, the
   command palette, a modal). One Escape press closes only the topmost —
   whichever registered entry with the highest priority reports itself open —
   not all of them at once. Pages register their own dismissable surfaces
   (e.g. the preview dock) alongside the ones core.js owns itself. */
const escapables = [];
function registerEscapable(isOpen, close, priority = 0) {
  escapables.push({ isOpen, close, priority });
  escapables.sort((a, b) => b.priority - a.priority);
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const item of escapables) {
    if (item.isOpen()) {
      item.close();
      return;
    }
  }
});

/* ---------- command palette ----------
   Shared shell used by both pages. Each page calls setPaletteActions(fn)
   with a function returning its current action list — built from
   already-loaded client state (agents, sessions, invoices…). The palette
   never triggers a network fetch on keystroke. Actions:
   {label, hint, group, action}. */
let paletteActionsProvider = () => [];
function setPaletteActions(fn) {
  paletteActionsProvider = fn;
}

let paletteFocusIndex = 0;
let paletteFiltered = [];

function fuzzyMatch(query, text) {
  query = query.trim().toLowerCase();
  text = text.toLowerCase();
  if (!query) return true;
  if (text.includes(query)) return true;
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i++;
    if (i === query.length) return true;
  }
  return false;
}

function isPaletteOpen() {
  return !$("#command-palette").classList.contains("hidden");
}

function renderPaletteRows() {
  const list = $("#palette-list");
  const empty = $("#palette-empty");
  const query = $("#palette-input").value;
  const all = paletteActionsProvider();
  paletteFiltered = all.filter((a) =>
    fuzzyMatch(query, `${a.label} ${a.hint || ""} ${a.group || ""}`)
  );
  paletteFocusIndex = 0;
  list.innerHTML = "";
  if (!paletteFiltered.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  let lastGroup = null;
  paletteFiltered.forEach((a, i) => {
    if (a.group && a.group !== lastGroup) {
      const gh = el("div", "palette-group");
      gh.textContent = a.group;
      list.appendChild(gh);
      lastGroup = a.group;
    }
    const row = el("button", "palette-row" + (i === 0 ? " focused" : ""));
    row.type = "button";
    row.setAttribute("role", "option");
    row.innerHTML =
      `<span class="palette-row-label">${escapeHtml(a.label)}</span>` +
      (a.hint ? `<span class="palette-row-hint">${escapeHtml(a.hint)}</span>` : "");
    row.addEventListener("click", () => {
      closePalette();
      a.action();
    });
    list.appendChild(row);
  });
}

function focusPaletteRow() {
  $$(".palette-row").forEach((r, i) => r.classList.toggle("focused", i === paletteFocusIndex));
  const rows = $$(".palette-row");
  if (rows[paletteFocusIndex]) rows[paletteFocusIndex].scrollIntoView({ block: "nearest" });
}

function openPalette() {
  $("#palette-input").value = "";
  renderPaletteRows();
  $("#command-palette").classList.remove("hidden");
  $("#palette-input").focus();
}
function closePalette() {
  $("#command-palette").classList.add("hidden");
}
registerEscapable(isPaletteOpen, closePalette, 20);

$("#palette-input").addEventListener("input", renderPaletteRows);
$("#palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteFocusIndex = Math.min(paletteFocusIndex + 1, paletteFiltered.length - 1);
    focusPaletteRow();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteFocusIndex = Math.max(paletteFocusIndex - 1, 0);
    focusPaletteRow();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const a = paletteFiltered[paletteFocusIndex];
    if (a) {
      closePalette();
      a.action();
    }
  }
});
$("#command-palette").addEventListener("mousedown", (e) => {
  if (e.target === $("#command-palette")) closePalette();
});

/* ---------- shortcuts sheet ---------- */
function isShortcutsOpen() {
  return !$("#shortcuts-overlay").classList.contains("hidden");
}
function closeShortcuts() {
  $("#shortcuts-overlay").classList.add("hidden");
}
function openShortcuts(rows) {
  const list = $("#shortcuts-list");
  list.innerHTML = "";
  rows.forEach(([label, keys]) => {
    const row = el("div", "shortcuts-row");
    const l = el("span");
    l.textContent = label;
    const k = el("span", "shortcuts-keys");
    k.innerHTML = keys.map((key) => `<kbd class="key">${escapeHtml(key)}</kbd>`).join(" ");
    row.append(l, k);
    list.appendChild(row);
  });
  $("#shortcuts-overlay").classList.remove("hidden");
}
registerEscapable(isShortcutsOpen, closeShortcuts, 15);
$("#shortcuts-close").addEventListener("click", closeShortcuts);
$("#shortcuts-overlay").addEventListener("mousedown", (e) => {
  if (e.target === $("#shortcuts-overlay")) closeShortcuts();
});

/* ---------- global shortcuts: Ctrl/Cmd+K (palette), Ctrl/Cmd+/ (help) ---------- */
const MOD_KEY = navigator.platform.toUpperCase().includes("MAC") ? "⌘" : "Ctrl";

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key.toLowerCase() === "k") {
    e.preventDefault();
    isPaletteOpen() ? closePalette() : openPalette();
  } else if (e.key === "/") {
    e.preventDefault();
    if (isShortcutsOpen()) closeShortcuts();
    else if (typeof buildShortcutsList === "function") openShortcuts(buildShortcutsList());
  }
});
