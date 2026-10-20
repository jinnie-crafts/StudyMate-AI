/**
 * StudyMate AI — Admin Panel AI Model Registry
 * 
 * Manages dynamic OpenRouter model configurations, provides connection
 * testing, capability tagging, role defaults, fallback ordering, and safe deletion.
 * Uses centralized adminAuthHelper for session-aware authentication, 401 token refresh,
 * request deduplication, and rate-limit backoff.
 */

import { adminFetch, getApiBaseUrl } from "./adminAuthHelper.js";

let modelsList = [];
let editingModelKey = null;
let isRegistryInitialized = false;
let isLoadingModels = false;
let pendingLoadPromise = null;

export async function initModelRegistry() {
  const container = document.getElementById("tab-models");
  if (!container) return;

  if (isRegistryInitialized) {
    if (modelsList.length === 0) {
      await loadModels(true);
    } else {
      renderTable();
    }
    return;
  }

  isRegistryInitialized = true;
  setupDom(container);
  bindEvents();
  await loadModels(true);
}

function setupDom(container) {
  container.innerHTML = `
    <header class="admin-header">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
        <div>
          <h1>AI Model Registry</h1>
          <p>Authoritative OpenRouter model configuration, capability mapping, and zero-downtime fallback controls.</p>
        </div>
        <div style="display: flex; gap: 10px; align-items: center;">
          <button id="refreshModelsBtn" class="secondary-btn" style="display: flex; align-items: center; gap: 6px; padding: 10px 16px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            Refresh
          </button>
          <button id="openAddModelModalBtn" class="primary-btn" style="display: flex; align-items: center; gap: 6px; padding: 10px 18px; font-weight: 600;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Add Model
          </button>
          <div id="modelCountBadge" style="padding: 8px 14px; background: rgba(124, 58, 237, 0.15); border: 1px solid rgba(124, 58, 237, 0.3); border-radius: 10px; font-size: 0.78rem; color: #c4b5fd; font-weight: 600;">
            Loading...
          </div>
        </div>
      </div>
    </header>

    <!-- Search & Filters -->
    <div style="margin-bottom: 20px; display: flex; gap: 12px; flex-wrap: wrap;">
      <input type="text" id="modelSearchInput" class="admin-input" placeholder="Search by name, key, or OpenRouter ID..." style="flex: 1; min-width: 260px;">
      <select id="modelRoleFilter" class="admin-input" style="width: 180px;">
        <option value="">All Roles</option>
        <option value="general_chat">General Chat</option>
        <option value="coding_assistant">Coding Assistant</option>
        <option value="exam_revision">Exam & Revision</option>
        <option value="fallback">Fallback Models</option>
        <option value="fast_classifier">Fast Classifier</option>
        <option value="security_guardrail">Security Guardrail</option>
      </select>
    </div>

    <!-- Models Table -->
    <div class="glass-card" style="padding: 0; overflow-x: auto; border-radius: 16px;">
      <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.88rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); color: var(--text-soft);">
            <th style="padding: 14px 18px;">Model & Key</th>
            <th style="padding: 14px 18px;">OpenRouter Provider ID</th>
            <th style="padding: 14px 18px;">Roles & Capabilities</th>
            <th style="padding: 14px 18px; text-align: center;">Priority</th>
            <th style="padding: 14px 18px; text-align: center;">Status</th>
            <th style="padding: 14px 18px; text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody id="modelsTableBody">
          <tr>
            <td colspan="6" style="padding: 30px; text-align: center; color: var(--text-soft);">Loading registered AI models...</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Add/Edit Model Modal -->
    <div id="modelConfigModal" class="modal modal-overlay" style="display: none;">
      <div class="modal-box glass-card" style="max-width: 620px; width: 92%; text-align: left; position: relative;">
        <button type="button" id="closeModelModalXBtn" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 18px; line-height: 1;">✕</button>
        <h3 id="modelModalTitle" style="margin-bottom: 8px; color: var(--text-main); font-size: 1.25rem;">Configure AI Model</h3>
        <p style="font-size: 13px; color: var(--text-soft); margin-bottom: 18px;">Changes instantly propagate to user Settings and AI runtime resolution without redeployment.</p>

        <form id="modelConfigForm" novalidate>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
            <div>
              <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-soft);">Internal Key *</label>
              <input type="text" id="modelInternalKey" class="admin-input" placeholder="e.g. general_chat" style="width: 100%; box-sizing: border-box;" required>
              <span id="modelInternalKeyHint" style="font-size: 11px; color: var(--text-muted); margin-top: 3px; display: block;">Stable internal role/feature identifier</span>
            </div>
            <div>
              <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-soft);">Display Name *</label>
              <input type="text" id="modelDisplayName" class="admin-input" placeholder="e.g. My Smart Study Model" style="width: 100%; box-sizing: border-box;" required>
              <span style="font-size: 11px; color: var(--text-muted); margin-top: 3px; display: block;">Label displayed in Settings & UI</span>
            </div>
          </div>

          <div style="margin-bottom: 14px;">
            <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-soft);">OpenRouter Provider ID *</label>
            <input type="text" id="modelProviderId" class="admin-input" placeholder="e.g. google/gemma-4-31b-it:free" style="width: 100%; box-sizing: border-box;" required>
            <span style="font-size: 11px; color: var(--text-muted); margin-top: 3px; display: block;">Exact upstream model identifier sent to OpenRouter API (e.g. <code>organization/model-name[:variant]</code>)</span>
          </div>

          <div style="margin-bottom: 14px;">
            <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-soft);">Description</label>
            <textarea id="modelDescription" class="admin-input" rows="2" placeholder="Explain the model's strengths, target audience, and speed profile..." style="width: 100%; box-sizing: border-box;"></textarea>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px;">
            <div>
              <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-soft);">Application Roles (comma-separated)</label>
              <input type="text" id="modelRoles" class="admin-input" placeholder="general_chat, coding_assistant" style="width: 100%; box-sizing: border-box;">
              <span style="font-size: 11px; color: var(--text-muted); margin-top: 2px; display: block;">Options: general_chat, coding_assistant, exam_revision, fallback, fast_classifier, security_guardrail</span>
            </div>
            <div>
              <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-soft);">Capabilities (comma-separated)</label>
              <input type="text" id="modelCapabilities" class="admin-input" placeholder="coding, reasoning, fast" style="width: 100%; box-sizing: border-box;">
              <span style="font-size: 11px; color: var(--text-muted); margin-top: 2px; display: block;">Keywords describing strengths (e.g. math, coding, fast)</span>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; align-items: center;">
            <div>
              <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-soft);">Fallback Priority (1 = Top)</label>
              <input type="number" id="modelFallbackPriority" class="admin-input" min="1" max="99" value="1" style="width: 100%; box-sizing: border-box;">
            </div>
            <div style="display: flex; gap: 16px; padding-top: 16px;">
              <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; color: var(--text-main);">
                <input type="checkbox" id="modelIsDefault"> Default for Role
              </label>
              <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; color: var(--text-main);">
                <input type="checkbox" id="modelEnabled" checked> Enabled
              </label>
            </div>
          </div>

          <!-- Connection Test Box -->
          <div id="testConnectionBox" style="margin-bottom: 18px; padding: 12px; background: rgba(0,0,0,0.25); border: 1px dashed var(--border); border-radius: 10px;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
              <span style="font-size: 12px; font-weight: 600; color: var(--text-soft);">Connection Verification</span>
              <button type="button" id="testPingBtn" class="secondary-btn" style="padding: 4px 10px; font-size: 11px;">Test Ping to OpenRouter</button>
            </div>
            <div id="testPingResult" style="font-size: 12px; color: var(--text-muted); line-height: 1.4;">
              Click "Test Ping" to verify model ID availability with a 1-token probe.
            </div>
          </div>

          <!-- Error Alert Banner -->
          <div id="modelFormErrorBanner" style="display: none; padding: 10px 14px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; color: #f87171; font-size: 12px; margin-bottom: 16px;"></div>

          <div style="display: flex; gap: 10px; justify-content: flex-end;">
            <button type="button" id="cancelModelModalBtn" class="secondary-btn" style="padding: 8px 18px;">Cancel</button>
            <button type="submit" id="saveModelSubmitBtn" class="primary-btn" style="padding: 8px 22px;">Save Model</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function bindEvents() {
  const refreshBtn = document.getElementById("refreshModelsBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => loadModels(true));

  const addBtn = document.getElementById("openAddModelModalBtn");
  if (addBtn) addBtn.addEventListener("click", () => openAddModal());

  const searchInput = document.getElementById("modelSearchInput");
  if (searchInput) searchInput.addEventListener("input", () => renderTable());

  const roleFilter = document.getElementById("modelRoleFilter");
  if (roleFilter) roleFilter.addEventListener("change", () => renderTable());

  const cancelBtn = document.getElementById("cancelModelModalBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", () => closeModal());

  const closeXBtn = document.getElementById("closeModelModalXBtn");
  if (closeXBtn) closeXBtn.addEventListener("click", () => closeModal());

  // Close modal when clicking on backdrop
  const modal = document.getElementById("modelConfigModal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
  }

  const form = document.getElementById("modelConfigForm");
  if (form) form.addEventListener("submit", (e) => handleFormSubmit(e));

  const testPingBtn = document.getElementById("testPingBtn");
  if (testPingBtn) testPingBtn.addEventListener("click", () => handleTestPing());

  const tbody = document.getElementById("modelsTableBody");
  if (tbody && !tbody.dataset.actionsBound) {
    tbody.dataset.actionsBound = "true";
    tbody.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const key = btn.dataset.key;
      dispatchAdminModelAction(action, key);
    });
  }
}

async function loadModels(forceRefresh = false) {
  if (isLoadingModels && pendingLoadPromise) {
    return pendingLoadPromise;
  }

  if (modelsList.length > 0 && !forceRefresh) {
    renderTable();
    return modelsList;
  }

  const tbody = document.getElementById("modelsTableBody");
  if (tbody && modelsList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding: 30px; text-align: center; color: var(--text-soft);">Loading registered AI models...</td></tr>`;
  }

  isLoadingModels = true;
  pendingLoadPromise = (async () => {
    try {
      const res = await adminFetch("/api/admin/models");

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 401) {
          throw new Error(err.error || "Authentication required or session expired. Please sign in.");
        } else if (res.status === 403) {
          throw new Error(err.error || "Forbidden: Requires administrator privileges.");
        } else if (res.status === 429) {
          throw new Error(err.error || "Too many admin requests. Rate limit active, please wait.");
        }
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      modelsList = Array.isArray(data.models) ? data.models : [];
      updateCountBadge();
      renderTable();
      return modelsList;
    } catch (err) {
      console.error("[AdminModelRegistry] Load error:", err);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding: 24px; text-align: center; color: #ef4444;">
          <div style="font-weight: 600; margin-bottom: 6px;">Failed to load models: ${escapeHtml(err.message)}</div>
          <button class="secondary-btn" style="margin-top: 8px; font-size: 0.8rem; padding: 6px 14px;" data-action="refresh">Retry Fetch</button>
        </td></tr>`;
      }
    } finally {
      isLoadingModels = false;
      pendingLoadPromise = null;
    }
  })();

  return pendingLoadPromise;
}

function updateCountBadge() {
  const badge = document.getElementById("modelCountBadge");
  if (!badge) return;
  const activeCount = modelsList.filter(m => m.enabled).length;
  badge.textContent = `${modelsList.length} Models (${activeCount} Active)`;
}

function renderTable() {
  const tbody = document.getElementById("modelsTableBody");
  if (!tbody) return;

  const searchTerm = (document.getElementById("modelSearchInput")?.value || "").toLowerCase().trim();
  const roleFilter = document.getElementById("modelRoleFilter")?.value || "";

  const filtered = modelsList.filter(m => {
    if (roleFilter && (!Array.isArray(m.roles) || !m.roles.includes(roleFilter))) {
      return false;
    }
    if (searchTerm) {
      const haystack = `${m.internal_key} ${m.display_name} ${m.provider_id} ${m.description || ""}`.toLowerCase();
      return haystack.includes(searchTerm);
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding: 30px; text-align: center; color: var(--text-soft);">No models match your filter criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(model => {
    const rolesHtml = (model.roles || []).map(r => `<span style="display: inline-block; padding: 2px 7px; font-size: 0.72rem; border-radius: 4px; background: rgba(124, 58, 237, 0.15); color: #c4b5fd; margin-right: 4px;">${escapeHtml(r)}</span>`).join("");
    const capsHtml = (model.capabilities || []).map(c => `<span style="display: inline-block; padding: 1px 6px; font-size: 0.7rem; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--text-soft); margin-right: 3px;">${escapeHtml(c)}</span>`).join("");
    const statusBadge = model.enabled
      ? `<span style="display: inline-block; padding: 3px 10px; font-size: 0.75rem; font-weight: 600; border-radius: 12px; background: rgba(52, 211, 153, 0.15); color: #34d399;">Active</span>`
      : `<span style="display: inline-block; padding: 3px 10px; font-size: 0.75rem; font-weight: 600; border-radius: 12px; background: rgba(239, 68, 68, 0.15); color: #f87171;">Disabled</span>`;

    const defaultBadge = model.is_default
      ? `<span style="display: inline-block; padding: 2px 6px; font-size: 0.68rem; font-weight: 700; border-radius: 4px; background: #7c3aed; color: #fff; margin-left: 6px;">DEFAULT</span>`
      : "";

    return `
      <tr class="model-table-row" style="border-bottom: 1px solid var(--border); transition: background 0.2s;">
        <td style="padding: 14px 18px;">
          <div style="font-weight: 600; color: var(--text-main); display: flex; align-items: center;">
            ${escapeHtml(model.display_name)} ${defaultBadge}
          </div>
          <div style="font-size: 0.76rem; font-family: monospace; color: var(--text-muted); margin-top: 2px;">
            Key: ${escapeHtml(model.internal_key)}
          </div>
        </td>
        <td style="padding: 14px 18px; font-family: monospace; font-size: 0.8rem; color: var(--text-soft);">
          <code>${escapeHtml(model.provider_id)}</code>
        </td>
        <td style="padding: 14px 18px;">
          <div style="margin-bottom: 4px;">${rolesHtml}</div>
          <div>${capsHtml}</div>
        </td>
        <td style="padding: 14px 18px; text-align: center; color: var(--text-soft);">
          #${model.fallback_priority || 1}
        </td>
        <td style="padding: 14px 18px; text-align: center;">
          ${statusBadge}
        </td>
        <td style="padding: 14px 18px; text-align: right;">
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button class="secondary-btn" style="padding: 5px 10px; font-size: 0.75rem;" data-action="test" data-key="${escapeHtml(model.internal_key)}">Test</button>
            <button class="secondary-btn" style="padding: 5px 10px; font-size: 0.75rem;" data-action="edit" data-key="${escapeHtml(model.internal_key)}">Edit</button>
            <button class="secondary-btn" style="padding: 5px 10px; font-size: 0.75rem; color: ${model.enabled ? '#f87171' : '#34d399'};" data-action="toggle" data-key="${escapeHtml(model.internal_key)}">${model.enabled ? 'Disable' : 'Enable'}</button>
            <button class="secondary-btn" style="padding: 5px 10px; font-size: 0.75rem; color: #ef4444;" data-action="delete" data-key="${escapeHtml(model.internal_key)}">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

// Action dispatcher
function dispatchAdminModelAction(action, key) {
  if (action === "refresh") {
    loadModels(true);
    return;
  }
  const model = modelsList.find(m => m.internal_key === key);
  if (!model && action !== "add") return;

  if (action === "edit") {
    openEditModal(model);
  } else if (action === "toggle") {
    toggleModelEnabled(model);
  } else if (action === "delete") {
    confirmDeleteModel(model);
  } else if (action === "test") {
    testModelDirectly(model);
  }
}

window._adminModelAction = dispatchAdminModelAction;

function openAddModal() {
  editingModelKey = null;
  const modal = document.getElementById("modelConfigModal");
  if (!modal) return;

  clearFormError();
  document.getElementById("modelModalTitle").textContent = "Add New AI Model";
  const keyInput = document.getElementById("modelInternalKey");
  keyInput.disabled = false;
  keyInput.value = "";
  keyInput.placeholder = "e.g. gemma_exam_pro";
  document.getElementById("modelInternalKeyHint").textContent = "Unique lowercase key (e.g. gemma_exam_pro). Cannot be changed after creation.";

  const providerInput = document.getElementById("modelProviderId");
  providerInput.value = "";
  providerInput.disabled = false;
  providerInput.placeholder = "e.g. google/gemma-4-31b-it:free";
  providerInput.title = "Enter the exact OpenRouter provider model identifier.";

  document.getElementById("modelDisplayName").value = "";
  document.getElementById("modelDescription").value = "";
  document.getElementById("modelRoles").value = "general_chat";
  document.getElementById("modelCapabilities").value = "chat, reasoning";
  document.getElementById("modelFallbackPriority").value = "1";
  document.getElementById("modelIsDefault").checked = false;
  document.getElementById("modelEnabled").checked = true;
  document.getElementById("testPingResult").innerHTML = "Click 'Test Ping' to verify model ID availability with a 1-token probe.";

  modal.classList.add("show");
  modal.style.display = "flex";
}

function openEditModal(model) {
  editingModelKey = model.internal_key;
  const modal = document.getElementById("modelConfigModal");
  if (!modal) return;

  clearFormError();
  document.getElementById("modelModalTitle").textContent = `Edit Model: ${model.display_name}`;

  const keyInput = document.getElementById("modelInternalKey");
  keyInput.value = model.internal_key;
  keyInput.disabled = true; // Internal key is the stable identifier
  document.getElementById("modelInternalKeyHint").textContent = "Internal keys identify logical model records and cannot be altered.";

  // Both display_name and provider_id are fully editable!
  document.getElementById("modelDisplayName").value = model.display_name || "";
  const providerInput = document.getElementById("modelProviderId");
  providerInput.value = model.provider_id || "";
  providerInput.disabled = false;
  providerInput.title = "Exact upstream model ID sent to OpenRouter.";

  document.getElementById("modelDescription").value = model.description || "";
  document.getElementById("modelRoles").value = (model.roles || []).join(", ");
  document.getElementById("modelCapabilities").value = (model.capabilities || []).join(", ");
  document.getElementById("modelFallbackPriority").value = model.fallback_priority || 1;
  document.getElementById("modelIsDefault").checked = Boolean(model.is_default);
  document.getElementById("modelEnabled").checked = model.enabled !== false;
  document.getElementById("testPingResult").innerHTML = "Click 'Test Ping' to verify model ID availability with a 1-token probe.";

  modal.classList.add("show");
  modal.style.display = "flex";
}

function closeModal() {
  const modal = document.getElementById("modelConfigModal");
  if (modal) {
    modal.classList.remove("show");
    modal.style.display = "none";
  }
  editingModelKey = null;
  clearFormError();
}

function setFormError(msg) {
  const banner = document.getElementById("modelFormErrorBanner");
  if (!banner) return;
  banner.textContent = msg;
  banner.style.display = "block";
}

function clearFormError() {
  const banner = document.getElementById("modelFormErrorBanner");
  if (!banner) return;
  banner.textContent = "";
  banner.style.display = "none";
}

async function handleFormSubmit(e) {
  e.preventDefault();
  clearFormError();

  const submitBtn = document.getElementById("saveModelSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving...";

  const rawKey = document.getElementById("modelInternalKey").value.trim().toLowerCase();
  const displayName = document.getElementById("modelDisplayName").value.trim();
  const providerId = document.getElementById("modelProviderId").value.trim();
  const description = document.getElementById("modelDescription").value.trim();
  const rolesRaw = document.getElementById("modelRoles").value;
  const capabilitiesRaw = document.getElementById("modelCapabilities").value;
  const fallbackPriority = parseInt(document.getElementById("modelFallbackPriority").value, 10) || 1;
  const isDefault = document.getElementById("modelIsDefault").checked;
  const enabled = document.getElementById("modelEnabled").checked;

  const roles = rolesRaw.split(",").map(r => r.trim()).filter(Boolean);
  const capabilities = capabilitiesRaw.split(",").map(c => c.trim()).filter(Boolean);

  // Client-side validation
  if (!rawKey) {
    setFormError("Internal Key is required.");
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Model";
    return;
  }
  if (!displayName || displayName.length < 2) {
    setFormError("Display Name must be at least 2 characters.");
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Model";
    return;
  }
  if (!providerId || !providerId.includes("/")) {
    setFormError("OpenRouter Provider ID must be in format 'organization/model-name[:variant]'.");
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Model";
    return;
  }

  const payload = {
    internal_key: rawKey,
    display_name: displayName,
    provider_id: providerId,
    description,
    roles,
    capabilities,
    fallback_priority: fallbackPriority,
    is_default: isDefault,
    enabled
  };

  try {
    const endpoint = editingModelKey
      ? `/api/admin/models/${encodeURIComponent(editingModelKey)}`
      : `/api/admin/models`;

    const method = editingModelKey ? "PUT" : "POST";
    const res = await adminFetch(endpoint, {
      method,
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    alertToast(`Model '${displayName}' saved successfully!`, "success");
    closeModal();
    window.dispatchEvent(new CustomEvent("model-registry-updated"));
    await loadModels(true);
  } catch (err) {
    console.error("[AdminModelRegistry] Save error:", err);
    // Keep modal open and preserve form values
    setFormError(`Save failed: ${err.message}`);
    alertToast(err.message, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Model";
  }
}

async function toggleModelEnabled(model) {
  try {
    const res = await adminFetch(`/api/admin/models/${encodeURIComponent(model.internal_key)}`, {
      method: "PUT",
      body: JSON.stringify({
        enabled: !model.enabled
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    alertToast(`Model '${model.display_name}' ${!model.enabled ? 'enabled' : 'disabled'}.`, "success");
    window.dispatchEvent(new CustomEvent("model-registry-updated"));
    await loadModels(true);
  } catch (err) {
    alertToast(err.message, "error");
  }
}

async function confirmDeleteModel(model) {
  const confirmed = window.confirm(`Are you sure you want to delete model '${model.display_name}' (${model.internal_key})? This action cannot be undone.`);
  if (!confirmed) return;

  try {
    const res = await adminFetch(`/api/admin/models/${encodeURIComponent(model.internal_key)}`, {
      method: "DELETE"
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    alertToast(`Model '${model.display_name}' deleted successfully.`, "success");
    window.dispatchEvent(new CustomEvent("model-registry-updated"));
    await loadModels(true);
  } catch (err) {
    alertToast(err.message, "error");
  }
}

async function handleTestPing() {
  const providerId = document.getElementById("modelProviderId").value.trim();
  const resultDiv = document.getElementById("testPingResult");
  const pingBtn = document.getElementById("testPingBtn");

  if (!providerId) {
    resultDiv.innerHTML = `<span style="color: #ef4444;">Please enter an OpenRouter Model ID first.</span>`;
    return;
  }

  pingBtn.disabled = true;
  pingBtn.textContent = "Testing...";
  resultDiv.innerHTML = `<span style="color: var(--text-soft);">Sending test probe to OpenRouter...</span>`;

  try {
    const res = await adminFetch("/api/admin/models/test", {
      method: "POST",
      body: JSON.stringify({ provider_id: providerId })
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      const errMsg = data.error || `HTTP ${res.status}`;
      resultDiv.innerHTML = `
        <div style="color: #ef4444; font-weight: 600;">❌ Test Failed (${data.latencyMs || 0}ms)</div>
        <div style="color: var(--text-soft); font-size: 11px; margin-top: 2px;">${escapeHtml(errMsg)}</div>
      `;
    } else {
      resultDiv.innerHTML = `
        <div style="color: #34d399; font-weight: 600;">✅ Connection Verified (${data.latencyMs}ms)</div>
        <div style="color: var(--text-soft); font-size: 11px; margin-top: 2px;">Model responded: <em>"${escapeHtml(data.reply)}"</em></div>
      `;
    }
  } catch (err) {
    resultDiv.innerHTML = `<span style="color: #ef4444;">Error testing model: ${escapeHtml(err.message)}</span>`;
  } finally {
    pingBtn.disabled = false;
    pingBtn.textContent = "Test Ping to OpenRouter";
  }
}

async function testModelDirectly(model) {
  alertToast(`Testing connection to ${model.display_name}...`, "info");
  try {
    const res = await adminFetch("/api/admin/models/test", {
      method: "POST",
      body: JSON.stringify({ provider_id: model.provider_id })
    });

    const data = await res.json();
    if (res.ok && data.ok) {
      alertToast(`✅ ${model.display_name} connected successfully! Latency: ${data.latencyMs}ms`, "success");
    } else {
      alertToast(`❌ Test failed for ${model.display_name}: ${data.error || "Connection refused"}`, "error");
    }
  } catch (err) {
    alertToast(`Test error: ${err.message}`, "error");
  }
}

function alertToast(msg, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `admin-toast toast-${type}`;
  toast.style.cssText = `
    padding: 12px 18px;
    background: ${type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#3b82f6')};
    color: #fff;
    border-radius: 8px;
    margin-bottom: 8px;
    font-size: 0.85rem;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    animation: fadeIn 0.3s ease;
  `;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
