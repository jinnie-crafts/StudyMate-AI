/**
 * StudyMate AI — Model Registry Client
 * 
 * Provides centralized client-side access to the authoritative OpenRouter
 * model registry. Populates model selectors, renders descriptions and verified
 * capabilities, and caches model metadata in-memory with TTL freshness.
 */

const MODEL_CACHE_TTL_MS = 60 * 1000; // 60 seconds
let cachedModels = null;
let lastFetchTime = 0;

// Authoritative Fallback Client Models matching production registry
export const FALLBACK_CLIENT_MODELS = [
  {
    internal_key: "general_chat",
    display_name: "Gemma 4 31B (Free)",
    provider_id: "google/gemma-4-31b-it:free",
    description: "High-intelligence flagship model with deep subject comprehension, balanced latency, and reasoning capabilities.",
    capabilities: ["general", "chat", "explanations", "reasoning", "exam"],
    roles: ["general_chat", "exam_revision"],
    is_default: true,
    enabled: true
  },
  {
    internal_key: "coding_assistant",
    display_name: "Cohere North Mini Code (Free)",
    provider_id: "cohere/north-mini-code:free",
    description: "Specialized code generation engine for syntax diagnostics, bug fixes, refactoring, and algorithms.",
    capabilities: ["coding", "syntax", "debug"],
    roles: ["coding_assistant"],
    is_default: true,
    enabled: true
  },
  {
    internal_key: "fallback_model",
    display_name: "Gemma 4 26B A4B (Free)",
    provider_id: "google/gemma-4-26b-a4b-it:free",
    description: "Reliable fallback model used when primary endpoints experience rate limits or downtime.",
    capabilities: ["fallback", "general"],
    roles: ["fallback", "security_guardrail"],
    is_default: false,
    enabled: true
  },
  {
    internal_key: "apodex_mini",
    display_name: "Apodex 1.1 Mini (Free)",
    provider_id: "apodex/apodex-1.1-mini:free",
    description: "Ultra-fast lightweight fallback engine for rapid response, intent detection, and failover continuity.",
    capabilities: ["fallback", "fast", "general"],
    roles: ["fallback", "fast_classifier"],
    is_default: false,
    enabled: true
  }
];

export const LEGACY_KEY_ALIASES = {
  deepseek: "general_chat",
  deepseek_r1: "general_chat",
  qwen: "coding_assistant",
  qwen_2_5_72b: "coding_assistant",
  llama: "general_chat",
  llama_3_3_70b: "general_chat",
  coding: "coding_assistant",
  gemma: "general_chat",
  exam_revision: "general_chat",
  fast_classifier: "apodex_mini",
  security_classifier: "fallback_model"
};

function getApiBaseUrl() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return window.location.port === "3001" ? "" : `http://${host}:3001`;
  }
  return host.includes("onrender.com") ? "" : "https://api.aadirishi.in";
}

/**
 * Fetch enabled models from authoritative backend registry
 */
export async function fetchAvailableModels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedModels && (now - lastFetchTime < MODEL_CACHE_TTL_MS)) {
    return cachedModels;
  }

  try {
    const baseUrl = getApiBaseUrl();
    const res = await fetch(`${baseUrl}/api/models`, {
      headers: { "Accept": "application/json" }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Failed to fetch models`);
    }

    const data = await res.json();
    if (Array.isArray(data.models) && data.models.length > 0) {
      cachedModels = data.models;
      lastFetchTime = now;
      return cachedModels;
    }
  } catch (err) {
    console.warn("[ModelRegistryClient] Backend unreachable or returned error, using fallback defaults:", err.message);
  }

  return cachedModels || FALLBACK_CLIENT_MODELS;
}

/**
 * Invalidate in-memory model cache
 */
export function invalidateModelCache() {
  cachedModels = null;
  lastFetchTime = 0;
}

// Global listener for live admin registry updates
if (typeof window !== "undefined") {
  window.addEventListener("model-registry-updated", () => {
    invalidateModelCache();
    const selectEl = document.getElementById("aiModelSelect");
    const detailsContainer = document.getElementById("aiModelDetailsContainer");
    if (selectEl) {
      const currentVal = selectEl.value;
      populateModelSelect(selectEl, currentVal, detailsContainer).catch(err => {
        console.warn("[ModelRegistryClient] Auto-refresh of model selector failed:", err.message);
      });
    }
  });
}


/**
 * Populate a <select> element with registry models and render dynamic metadata details
 * @param {HTMLSelectElement} selectEl
 * @param {string} currentSelection - currently saved internal_key (or 'auto')
 * @param {HTMLElement} [detailsContainer] - optional element to render active model specs
 * @param {Object} [options] - optional filter options (e.g. role)
 */
export async function populateModelSelect(selectEl, currentSelection = "auto", detailsContainer = null, options = {}) {
  if (!selectEl) return;

  const models = await fetchAvailableModels();

  // Normalize legacy selection aliases (e.g. 'deepseek' -> 'deepseek_r1')
  let safeSelection = currentSelection || "auto";
  if (safeSelection && LEGACY_KEY_ALIASES[safeSelection]) {
    const migratedKey = LEGACY_KEY_ALIASES[safeSelection];
    safeSelection = migratedKey;

    // Migrate stored user settings in localStorage if present
    try {
      const stored = localStorage.getItem("appSettings");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && (parsed.aiModel === currentSelection || LEGACY_KEY_ALIASES[parsed.aiModel])) {
          parsed.aiModel = migratedKey;
          localStorage.setItem("appSettings", JSON.stringify(parsed));
        }
      }
    } catch (e) {
      // non-critical localStorage migration error
    }
  }

  const USER_FACING_ROLES = ["general_chat", "coding_assistant", "exam_revision"];
  const userSelectableModels = models.filter(m => {
    if (!m.enabled) return false;
    // Check if role filter is requested
    if (options.role) {
      return Array.isArray(m.roles) && (m.roles.includes(options.role) || (options.role === "exam_revision" && m.roles.includes("general_chat")));
    }
    // Must have at least one user-facing role
    if (Array.isArray(m.roles)) {
      return m.roles.some(r => USER_FACING_ROLES.includes(r));
    }
    return true;
  });


  // Build options
  selectEl.innerHTML = "";

  // Always offer Auto option
  const autoOpt = document.createElement("option");
  autoOpt.value = "auto";
  autoOpt.textContent = "Auto (Balanced - Recommended)";
  selectEl.appendChild(autoOpt);

  let selectionFound = safeSelection === "auto";

  userSelectableModels.forEach(model => {
    const opt = document.createElement("option");
    opt.value = model.internal_key;
    const defaultTag = model.is_default ? " ★" : "";
    opt.textContent = `${model.display_name}${defaultTag}`;
    if (model.internal_key === safeSelection) {
      opt.selected = true;
      selectionFound = true;
    }
    selectEl.appendChild(opt);
  });

  // If previous selection is no longer available in the registry, gracefully fall back to 'auto'
  if (!selectionFound) {
    selectEl.value = "auto";
  } else {
    selectEl.value = safeSelection;
  }

  const renderDetails = () => {
    if (!detailsContainer) return;
    const activeKey = selectEl.value;

    if (activeKey === "auto") {
      detailsContainer.innerHTML = `
        <div class="model-spec-card" style="margin-top: 10px; padding: 12px 14px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 12px; font-size: 0.82rem; color: var(--text-soft);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <strong style="color: var(--text-main); font-size: 0.88rem;">Intelligent Auto-Routing</strong>
            <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; background: rgba(52, 211, 153, 0.15); color: #34d399;">Active</span>
          </div>
          <p style="margin: 0 0 8px 0; line-height: 1.45;">Dynamically directs questions to the optimal model based on mode (General Chat, Coding, or Exam Revision) with automatic zero-downtime fallback.</p>
          <div style="font-size: 0.75rem; color: var(--text-muted); opacity: 0.85;">Managed by StudyMate AI Centralized Registry</div>
        </div>
      `;
      return;
    }

    const model = models.find(m => m.internal_key === activeKey);
    if (!model) {
      detailsContainer.innerHTML = "";
      return;
    }

    const caps = Array.isArray(model.capabilities) ? model.capabilities : [];
    const capsBadges = caps.map(c => `<span style="display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 0.7rem; background: rgba(255,255,255,0.07); color: var(--text-main); margin-right: 4px; text-transform: capitalize;">${escapeHtml(c)}</span>`).join("");

    detailsContainer.innerHTML = `
      <div class="model-spec-card" style="margin-top: 10px; padding: 12px 14px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 12px; font-size: 0.82rem; color: var(--text-soft);">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
          <strong style="color: var(--text-main); font-size: 0.88rem;">${escapeHtml(model.display_name)}</strong>
          ${model.is_default ? '<span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; background: rgba(124, 58, 237, 0.2); color: #a78bfa;">Role Default</span>' : ''}
        </div>
        <p style="margin: 0 0 8px 0; line-height: 1.45;">${escapeHtml(model.description || "High-performance LLM configured in the StudyMate AI registry.")}</p>
        <div style="margin-bottom: 8px;">
          ${capsBadges}
        </div>
        <details style="font-size: 0.72rem; color: var(--text-muted); cursor: pointer;">
          <summary style="outline: none;">Technical Provider Details</summary>
          <div style="margin-top: 6px; font-family: monospace; padding: 4px 8px; background: rgba(0,0,0,0.25); border-radius: 6px; word-break: break-all;">
            OpenRouter ID: <code>${escapeHtml(model.provider_id)}</code>
          </div>
        </details>
      </div>
    `;
  };

  renderDetails();

  // Remove any previously attached registry listeners to prevent stacking
  if (selectEl._registryChangeHandler) {
    selectEl.removeEventListener("change", selectEl._registryChangeHandler);
  }
  selectEl._registryChangeHandler = renderDetails;
  selectEl.addEventListener("change", renderDetails);
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
