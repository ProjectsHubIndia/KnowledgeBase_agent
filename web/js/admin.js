"use strict";

/* Admin console: manage agents (name + system prompt) and user accounts,
   and decide which agents each user may chat with. Agents have no tool
   configuration — the toolset is fixed in the backend.

   $, el, escapeHtml, safeJson, confirmDialog/confirmDialogEx, toast, theme,
   and the auth token helpers + fetch wrapper all come from core.js, loaded
   before this file. */

let agents = [];
let users = [];
let editingAgent = null; // agent object, or null for "new"
let editingUser = null;
let promptDefaults = null; // {default_persona, tool_contract}, fetched once

/** Raise the server's message so form errors are actionable. */
async function apiCall(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 204) return null;
  const data = await safeJson(r);
  if (!r.ok) {
    const detail = data.detail;
    throw new Error(
      typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : "Request failed"
    );
  }
  return data;
}

function showError(node, message) {
  node.textContent = message;
  node.classList.remove("hidden");
}

async function ensureDefaults() {
  if (promptDefaults) return promptDefaults;
  promptDefaults = await apiCall("/admin/defaults");
  return promptDefaults;
}

/* ---------- tabs ---------- */
function activateTab(name) {
  document.querySelectorAll(".admin-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#tab-overview").classList.toggle("hidden", name !== "overview");
  $("#tab-agents").classList.toggle("hidden", name !== "agents");
  $("#tab-users").classList.toggle("hidden", name !== "users");
  if (name === "overview") renderOverview();
}
document.querySelectorAll(".admin-tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

/* ---------- overview ---------- */
function renderOverview() {
  const invoices = agents.reduce((n, a) => n + (a.invoice_count || 0), 0);
  const documents = agents.reduce((n, a) => n + (a.document_count || 0), 0);
  $("#stat-agents").textContent = agents.length;
  $("#stat-users").textContent = users.length;
  $("#stat-invoices").textContent = invoices;
  $("#stat-documents").textContent = documents;
}

/* ---------- agents ---------- */
async function loadAgents() {
  agents = await apiCall("/admin/agents");
  renderAgents();
}

function renderAgents() {
  const list = $("#agent-list");
  list.innerHTML = "";
  if (!agents.length) {
    list.innerHTML = `<p class="session-empty">No agents yet.</p>`;
    return;
  }
  agents.forEach((a) => {
    const item = el("button", "admin-item" + (editingAgent && editingAgent.id === a.id ? " active" : ""));
    item.type = "button";
    const meta = `${a.invoice_count} invoice${a.invoice_count === 1 ? "" : "s"} · ${a.document_count} document${a.document_count === 1 ? "" : "s"}`;
    item.innerHTML = `
      <span class="admin-item-name">${escapeHtml(a.name)}${a.is_active ? "" : ' <em class="admin-badge">inactive</em>'}</span>
      <span class="admin-item-meta">${escapeHtml(meta)}</span>`;
    item.addEventListener("click", () => editAgent(a));
    list.appendChild(item);
  });
}

function updatePromptCount() {
  $("#agent-prompt-count").textContent = `${$("#agent-prompt").value.length} chars`;
}
$("#agent-prompt").addEventListener("input", updatePromptCount);

async function editAgent(agent) {
  editingAgent = agent;
  await ensureDefaults().catch(() => {}); // best-effort — form still works without it
  $("#agent-form").classList.remove("hidden");
  $("#agent-error").classList.add("hidden");
  $("#agent-form-title").textContent = agent ? `Edit "${agent.name}"` : "New agent";
  $("#agent-name").value = agent ? agent.name : "";
  $("#agent-desc").value = agent ? agent.description || "" : "";
  $("#agent-prompt").value = agent
    ? agent.system_prompt
    : (promptDefaults && promptDefaults.default_persona) || "";
  $("#agent-suggestions").value = agent ? agent.suggestions || "" : "";
  $("#agent-active").checked = agent ? agent.is_active : true;
  $("#agent-contract-body").textContent = (promptDefaults && promptDefaults.tool_contract) || "";
  $("#agent-delete").classList.toggle("hidden", !agent);
  updatePromptCount();
  renderAgents();
  $("#agent-name").focus();
}

$("#new-agent").addEventListener("click", () => editAgent(null));
$("#agent-cancel").addEventListener("click", () => {
  editingAgent = null;
  $("#agent-form").classList.add("hidden");
  renderAgents();
});
$("#agent-reset-prompt").addEventListener("click", async () => {
  await ensureDefaults().catch(() => {});
  if (promptDefaults) {
    $("#agent-prompt").value = promptDefaults.default_persona;
    updatePromptCount();
  }
});

$("#agent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: $("#agent-name").value.trim(),
    description: $("#agent-desc").value.trim(),
    system_prompt: $("#agent-prompt").value.trim(),
    is_active: $("#agent-active").checked,
    suggestions: $("#agent-suggestions").value.trim(),
  };
  const save = $("#agent-save");
  save.disabled = true;
  try {
    if (editingAgent) {
      await apiCall(`/admin/agents/${editingAgent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      await apiCall("/admin/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    editingAgent = null;
    $("#agent-form").classList.add("hidden");
    await loadAgents();
    await loadUsers(); // the grant checkboxes list agents
    renderOverview();
  } catch (err) {
    showError($("#agent-error"), err.message);
  } finally {
    save.disabled = false;
  }
});

$("#agent-delete").addEventListener("click", async () => {
  if (!editingAgent) return;
  const agent = editingAgent;
  const hasData = agent.invoice_count + agent.document_count > 0;
  const result = await confirmDialogEx(
    `Delete "${agent.name}"?`,
    hasData
      ? `Its ${agent.invoice_count} invoice(s) and ${agent.document_count} document(s) are kept on disk unless you choose to purge them below — recreating an agent with the same name does not restore them either way, but the files stay recoverable from disk until purged.`
      : "This cannot be undone.",
    hasData ? { checkboxLabel: "Also delete its files from disk — cannot be undone" } : {}
  );
  if (!result.ok) return;
  try {
    const qs = result.checked ? "?purge=true" : "";
    await apiCall(`/admin/agents/${agent.id}${qs}`, { method: "DELETE" });
    editingAgent = null;
    $("#agent-form").classList.add("hidden");
    await loadAgents();
    await loadUsers();
    renderOverview();
  } catch (err) {
    showError($("#agent-error"), err.message);
  }
});

/* ---------- users ---------- */
async function loadUsers() {
  users = await apiCall("/admin/users");
  renderUsers();
  if (editingUser) renderGrants(editingUser.agent_ids);
}

function renderUsers() {
  const list = $("#user-list");
  list.innerHTML = "";
  if (!users.length) {
    list.innerHTML = `<p class="session-empty">No users yet.</p>`;
    return;
  }
  users.forEach((u) => {
    const item = el("button", "admin-item" + (editingUser && editingUser.id === u.id ? " active" : ""));
    item.type = "button";
    const scope =
      u.role === "admin"
        ? "all agents"
        : `${u.agent_ids.length} agent${u.agent_ids.length === 1 ? "" : "s"}`;
    item.innerHTML = `
      <span class="admin-item-name">${escapeHtml(u.username)}${u.is_active ? "" : ' <em class="admin-badge">disabled</em>'}</span>
      <span class="admin-item-meta">${escapeHtml(u.role)} · ${escapeHtml(scope)}</span>`;
    item.addEventListener("click", () => editUser(u));
    list.appendChild(item);
  });
}

/* ---------- role segmented control ---------- */
function getRole() {
  return $("#user-role").dataset.value;
}
function setRole(role) {
  $("#user-role").dataset.value = role;
  $$(".segmented-btn").forEach((b) => b.classList.toggle("active", b.dataset.role === role));
}
$$(".segmented-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    setRole(btn.dataset.role);
    const checked = [...$("#user-grants").querySelectorAll("input:checked")].map((c) => c.value);
    renderGrants(checked.length ? checked : editingUser ? editingUser.agent_ids : []);
  });
});

/** Checkbox per agent. Admins implicitly reach every agent, so the grid is
    disabled for them rather than pretending the choice matters. */
function renderGrants(selected) {
  const box = $("#user-grants");
  const isAdmin = getRole() === "admin";
  box.innerHTML = "";
  if (!agents.length) {
    box.innerHTML = `<p class="admin-note">Create an agent first.</p>`;
    return;
  }
  if (isAdmin) {
    box.innerHTML = `<p class="admin-note">Administrators can use every agent.</p>`;
    return;
  }
  agents.forEach((a) => {
    const label = el("label", "admin-check");
    const cb = el("input");
    cb.type = "checkbox";
    cb.value = a.id;
    cb.checked = (selected || []).includes(a.id);
    cb.disabled = !a.is_active;
    const text = el("span");
    text.textContent = a.is_active ? a.name : `${a.name} (inactive)`;
    label.append(cb, text);
    box.appendChild(label);
  });
}

function editUser(user) {
  editingUser = user;
  $("#user-form").classList.remove("hidden");
  $("#user-error").classList.add("hidden");
  $("#user-form-title").textContent = user ? `Edit "${user.username}"` : "New user";
  $("#user-name").value = user ? user.username : "";
  $("#user-name").disabled = !!user; // usernames are the login, so they're fixed
  $("#user-pw").value = "";
  $("#user-pw-label").textContent = user ? "New password (leave blank to keep)" : "Password";
  setRole(user ? user.role : "user");
  $("#user-active").checked = user ? user.is_active : true;
  $("#user-delete").classList.toggle("hidden", !user);
  renderGrants(user ? user.agent_ids : []);
  renderUsers();
  if (!user) $("#user-name").focus();
}

$("#new-user").addEventListener("click", () => editUser(null));
$("#user-cancel").addEventListener("click", () => {
  editingUser = null;
  $("#user-form").classList.add("hidden");
  renderUsers();
});

$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = getRole();
  const grants = [...$("#user-grants").querySelectorAll("input:checked")].map((c) => c.value);
  const password = $("#user-pw").value;
  const save = $("#user-save");
  save.disabled = true;
  try {
    if (editingUser) {
      const patch = { role, is_active: $("#user-active").checked };
      if (password) patch.password = password;
      await apiCall(`/admin/users/${editingUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      // Grants are a separate resource so an empty list means "revoke all".
      if (role !== "admin") {
        await apiCall(`/admin/users/${editingUser.id}/agents`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_ids: grants }),
        });
      }
    } else {
      if (!password) throw new Error("A password is required for a new user.");
      await apiCall("/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: $("#user-name").value.trim(),
          password,
          role,
          agent_ids: role === "admin" ? [] : grants,
        }),
      });
    }
    editingUser = null;
    $("#user-form").classList.add("hidden");
    await loadUsers();
    renderOverview();
  } catch (err) {
    showError($("#user-error"), err.message);
  } finally {
    save.disabled = false;
  }
});

$("#user-delete").addEventListener("click", async () => {
  if (!editingUser) return;
  const user = editingUser;
  const ok = await confirmDialog(
    `Delete "${user.username}"?`,
    "Their account and all of their conversations are removed."
  );
  if (!ok) return;
  try {
    await apiCall(`/admin/users/${user.id}`, { method: "DELETE" });
    editingUser = null;
    $("#user-form").classList.add("hidden");
    await loadUsers();
    renderOverview();
  } catch (err) {
    showError($("#user-error"), err.message);
  }
});

/* ---------- account menu + theme ---------- */
$("#admin-who-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#admin-account-menu").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!$("#admin-account").contains(e.target)) $("#admin-account-menu").classList.add("hidden");
});
$("#admin-logout-btn").addEventListener("click", () => {
  clearToken();
  location.reload();
});

$("#theme-toggle").title = `Theme: ${theme.get()}`;
$("#theme-toggle").addEventListener("click", () => {
  $("#theme-toggle").title = `Theme: ${theme.cycle()}`;
});

/* ---------- command palette + shortcuts ----------
   Built entirely from state already loaded on this page — no fetch fires
   when the palette opens or as you type. */
function buildPaletteActions() {
  const actions = [
    { group: "Go to", label: "Overview", action: () => activateTab("overview") },
    { group: "Go to", label: "Agents", action: () => activateTab("agents") },
    { group: "Go to", label: "Users", action: () => activateTab("users") },
    { group: "Agents", label: "+ New agent", action: () => { activateTab("agents"); editAgent(null); } },
    { group: "Users", label: "+ New user", action: () => { activateTab("users"); editUser(null); } },
  ];
  agents.forEach((a) => {
    actions.push({
      group: "Agents",
      label: a.name,
      hint: a.is_active ? "" : "inactive",
      action: () => { activateTab("agents"); editAgent(a); },
    });
  });
  users.forEach((u) => {
    actions.push({
      group: "Users",
      label: u.username,
      hint: u.role,
      action: () => { activateTab("users"); editUser(u); },
    });
  });
  actions.push({ group: "Account", label: "Back to chat", action: () => (location.href = "/") });
  actions.push({ group: "Account", label: "Log out", action: () => { clearToken(); location.reload(); } });
  return actions;
}
setPaletteActions(buildPaletteActions);

function buildShortcutsList() {
  return [
    ["Command palette", [MOD_KEY, "K"]],
    ["Shortcuts (this sheet)", [MOD_KEY, "/"]],
    ["Close palette / sheet / dialog", ["Esc"]],
  ];
}

/* ---------- boot ---------- */
function showConsole(user) {
  $("#boot-splash").classList.add("hidden");
  $("#login-overlay").classList.add("hidden");
  $("#admin-shell").classList.remove("hidden");
  $("#admin-who").textContent = user.username;
}

function showLogin(message) {
  $("#boot-splash").classList.add("hidden");
  $("#admin-shell").classList.add("hidden");
  $("#login-overlay").classList.remove("hidden");
  if (message) showError($("#login-error"), message);
}

async function start(user) {
  showConsole(user);
  await loadAgents();
  await loadUsers();
  renderOverview();
}

// An admin's own role/grant only changes here rarely (see the 403 note on
// setAuthHandlers below) — re-check identity and leave for the chat app if
// this account is no longer an administrator.
async function handleAdminAccessChanged() {
  try {
    const me = await apiCall("/auth/me");
    if (me.user.role !== "admin") {
      toast("Your admin access was removed.", { variant: "danger" });
      setTimeout(() => (location.href = "/"), 1200);
    }
  } catch {
    /* an invalid token is handled by onUnauthorized instead */
  }
}
setAuthHandlers({ onUnauthorized: () => showLogin(), onAccessChanged: handleAdminAccessChanged });

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
    if (!r.ok) throw new Error("Incorrect username or password.");
    const data = await r.json();
    if (data.user.role !== "admin") throw new Error("That account is not an administrator.");
    storeToken(data.access_token);
    await start(data.user);
  } catch (err) {
    showError($("#login-error"), err.message);
  } finally {
    submit.disabled = false;
  }
});

(async function boot() {
  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }
  // Hold on the boot splash (never the login modal) while the token is
  // verified, so a returning signed-in admin never sees a login flash.
  $("#boot-splash").classList.remove("hidden");
  try {
    const me = await apiCall("/auth/me");
    // A signed-in non-admin belongs in the chat app, not here.
    if (me.user.role !== "admin") {
      location.href = "/";
      return;
    }
    storeToken(token); // refresh the fa_auth cookie for this page load
    await start(me.user);
  } catch {
    clearToken();
    showLogin();
  }
})();
