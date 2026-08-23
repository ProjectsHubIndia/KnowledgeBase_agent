"use strict";

/* Admin console: manage agents (name + system prompt) and user accounts,
   and decide which agents each user may chat with. Agents have no tool
   configuration — the toolset is fixed in the backend. */

const $ = (sel) => document.querySelector(sel);
const AUTH_KEY = "invoice-agent.token";

let agents = [];
let users = [];
let editingAgent = null; // agent object, or null for "new"
let editingUser = null;

const rawFetch = window.fetch.bind(window);
window.fetch = (input, opts = {}) => {
  const token = sessionStorage.getItem(AUTH_KEY);
  if (!token) return rawFetch(input, opts);
  const headers = new Headers(opts.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return rawFetch(input, { ...opts, headers });
};

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

async function safeJson(r) {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

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
      resolve(val);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
  });
}

/* ---------- tabs ---------- */
document.querySelectorAll(".admin-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    $("#tab-agents").classList.toggle("hidden", name !== "agents");
    $("#tab-users").classList.toggle("hidden", name !== "users");
  });
});

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
      <span class="admin-item-name">${a.name}${a.is_active ? "" : ' <em class="admin-badge">inactive</em>'}</span>
      <span class="admin-item-meta">${meta}</span>`;
    item.addEventListener("click", () => editAgent(a));
    list.appendChild(item);
  });
}

function editAgent(agent) {
  editingAgent = agent;
  $("#agent-form").classList.remove("hidden");
  $("#agent-error").classList.add("hidden");
  $("#agent-form-title").textContent = agent ? `Edit “${agent.name}”` : "New agent";
  $("#agent-name").value = agent ? agent.name : "";
  $("#agent-desc").value = agent ? agent.description || "" : "";
  $("#agent-prompt").value = agent ? agent.system_prompt : "";
  $("#agent-active").checked = agent ? agent.is_active : true;
  $("#agent-delete").classList.toggle("hidden", !agent);
  renderAgents();
  $("#agent-name").focus();
}

$("#new-agent").addEventListener("click", () => editAgent(null));
$("#agent-cancel").addEventListener("click", () => {
  editingAgent = null;
  $("#agent-form").classList.add("hidden");
  renderAgents();
});

$("#agent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: $("#agent-name").value.trim(),
    description: $("#agent-desc").value.trim(),
    system_prompt: $("#agent-prompt").value.trim(),
    is_active: $("#agent-active").checked,
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
  const ok = await confirmDialog(
    `Delete “${agent.name}”?`,
    hasData
      ? `Its ${agent.invoice_count} invoice(s) and ${agent.document_count} document(s) are kept on disk and can be restored by recreating the agent.`
      : "This cannot be undone."
  );
  if (!ok) return;
  try {
    await apiCall(`/admin/agents/${agent.id}`, { method: "DELETE" });
    editingAgent = null;
    $("#agent-form").classList.add("hidden");
    await loadAgents();
    await loadUsers();
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
      <span class="admin-item-name">${u.username}${u.is_active ? "" : ' <em class="admin-badge">disabled</em>'}</span>
      <span class="admin-item-meta">${u.role} · ${scope}</span>`;
    item.addEventListener("click", () => editUser(u));
    list.appendChild(item);
  });
}

/** Checkbox per agent. Admins implicitly reach every agent, so the grid is
    disabled for them rather than pretending the choice matters. */
function renderGrants(selected) {
  const box = $("#user-grants");
  const isAdmin = $("#user-role").value === "admin";
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
  $("#user-form-title").textContent = user ? `Edit “${user.username}”` : "New user";
  $("#user-name").value = user ? user.username : "";
  $("#user-name").disabled = !!user; // usernames are the login, so they're fixed
  $("#user-pw").value = "";
  $("#user-pw-label").textContent = user ? "New password (leave blank to keep)" : "Password";
  $("#user-role").value = user ? user.role : "user";
  $("#user-active").checked = user ? user.is_active : true;
  $("#user-delete").classList.toggle("hidden", !user);
  renderGrants(user ? user.agent_ids : []);
  renderUsers();
  if (!user) $("#user-name").focus();
}

$("#user-role").addEventListener("change", () => {
  const checked = [...$("#user-grants").querySelectorAll("input:checked")].map((c) => c.value);
  renderGrants(checked.length ? checked : editingUser ? editingUser.agent_ids : []);
});

$("#new-user").addEventListener("click", () => editUser(null));
$("#user-cancel").addEventListener("click", () => {
  editingUser = null;
  $("#user-form").classList.add("hidden");
  renderUsers();
});

$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = $("#user-role").value;
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
    `Delete “${user.username}”?`,
    "Their account and all of their conversations are removed."
  );
  if (!ok) return;
  try {
    await apiCall(`/admin/users/${user.id}`, { method: "DELETE" });
    editingUser = null;
    $("#user-form").classList.add("hidden");
    await loadUsers();
  } catch (err) {
    showError($("#user-error"), err.message);
  }
});

/* ---------- boot ---------- */
function showConsole(user) {
  $("#login-overlay").classList.add("hidden");
  $("#admin-shell").classList.remove("hidden");
  $("#admin-who").textContent = `Signed in as ${user.username}`;
}

function showLogin(message) {
  $("#admin-shell").classList.add("hidden");
  $("#login-overlay").classList.remove("hidden");
  if (message) showError($("#login-error"), message);
}

async function start(user) {
  showConsole(user);
  await loadAgents();
  await loadUsers();
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
    if (!r.ok) throw new Error("Incorrect username or password.");
    const data = await r.json();
    if (data.user.role !== "admin") throw new Error("That account is not an administrator.");
    sessionStorage.setItem(AUTH_KEY, data.access_token);
    document.cookie = `fa_auth=${data.access_token}; path=/; max-age=86400; SameSite=Strict`;
    await start(data.user);
  } catch (err) {
    showError($("#login-error"), err.message);
  } finally {
    submit.disabled = false;
  }
});

(async function boot() {
  if (!sessionStorage.getItem(AUTH_KEY)) return showLogin();
  try {
    const me = await apiCall("/auth/me");
    // A signed-in non-admin belongs in the chat app, not here.
    if (me.user.role !== "admin") {
      location.href = "/";
      return;
    }
    await start(me.user);
  } catch {
    showLogin();
  }
})();
