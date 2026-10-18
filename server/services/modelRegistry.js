/**
 * Centralized OpenRouter Model Registry — StudyMate AI
 * 
 * Single source of truth for:
 * - Application roles (general_chat, coding_assistant, exam_revision, fast_classifier, security_guardrail, fallback)
 * - Internal keys vs Friendly display names vs Provider IDs
 * - Admin-configurable models stored in Firestore with in-memory caching
 * - Candidate fallback chains, zero-downtime failover, and OpenRouter connection testing
 * - Idempotent reconciliation between canonical production models and database state
 */

const fs = require('fs');
const path = require('path');
const { loggers } = require('./logger');
const log = loggers.server || console;

let db = null;
let FieldValue = null;

try {
  const serverKeyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  const rootKeyPath = path.join(__dirname, '..', '..', 'serviceAccountKey.json');
  const hasCreds = Boolean(
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_CONFIG ||
    fs.existsSync(serverKeyPath) ||
    fs.existsSync(rootKeyPath)
  );

  if (hasCreds) {
    const fb = require('./firebaseAdmin');
    db = fb.db;
    FieldValue = fb.FieldValue;
  }
} catch (e) {
  log.warn({ err: e.message }, '[ModelRegistry] Firebase Admin initialization skipped, running in-memory');
}

const CACHE_TTL_MS = 60 * 1000; // 60 seconds
let memoryRegistryCache = null;
let lastCacheFetchTime = 0;

// Authoritative Production Models — Grounded in commit 2a895e8 and active AI services
const CANONICAL_PRODUCTION_MODELS = [
  {
    internal_key: "general_chat",
    display_name: "Gemma 4 31B (Free)",
    provider_id: "google/gemma-4-31b-it:free",
    description: "Google's balanced high-capability model for everyday study, conceptual explanations, and problem solving.",
    capabilities: ["chat", "general", "reasoning"],
    roles: ["general_chat"],
    enabled: true,
    is_default: true,
    fallback_priority: 1,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "coding_assistant",
    display_name: "Cohere North Mini Code (Free)",
    provider_id: "cohere/north-mini-code:free",
    description: "Specialized code generation engine for syntax diagnostics, bug fixes, refactoring, and algorithms.",
    capabilities: ["coding", "debugging", "syntax"],
    roles: ["coding_assistant"],
    enabled: true,
    is_default: true,
    fallback_priority: 1,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "exam_revision",
    display_name: "Gemma 4 Exam & Revision (Free)",
    provider_id: "google/gemma-4-31b-it:free",
    description: "Tuned for revision notes, practice questions, flashcards, and syllabus drills.",
    capabilities: ["exam", "revision", "flashcards"],
    roles: ["exam_revision"],
    enabled: true,
    is_default: true,
    fallback_priority: 1,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "fallback_model",
    display_name: "Gemma 4 26B A4B (Free)",
    provider_id: "google/gemma-4-26b-a4b-it:free",
    description: "Reliable fallback model used when primary endpoints experience rate limits or downtime.",
    capabilities: ["fallback", "general"],
    roles: ["fallback"],
    enabled: true,
    is_default: true,
    fallback_priority: 2,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "apodex_mini",
    display_name: "Apodex 1.1 Mini (Free)",
    provider_id: "apodex/apodex-1.1-mini:free",
    description: "Ultra-fast lightweight fallback engine for rapid response and failover continuity.",
    capabilities: ["fallback", "fast", "general"],
    roles: ["fallback"],
    enabled: true,
    is_default: false,
    fallback_priority: 3,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "fast_classifier",
    display_name: "OpenRouter Free Router",
    provider_id: "openrouter/free",
    description: "Lightweight router for query classification, intent detection, and fast internal tasks.",
    capabilities: ["classification", "fast"],
    roles: ["fast_classifier"],
    enabled: true,
    is_default: true,
    fallback_priority: 1,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "security_classifier",
    display_name: "Gemini 2.5 Flash Exp (Free)",
    provider_id: "google/gemini-2.5-flash-exp:free",
    description: "Dedicated AI safety model for semantic guardrail evaluation and threat classification.",
    capabilities: ["security", "classifier", "fast"],
    roles: ["security_guardrail", "fast_classifier"],
    enabled: true,
    is_default: true,
    fallback_priority: 1,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "deepseek_r1",
    display_name: "DeepSeek R1 (Free)",
    provider_id: "deepseek/deepseek-r1:free",
    description: "Advanced reasoning engine specializing in deep mathematical proof and analytical logic.",
    capabilities: ["reasoning", "math", "analysis"],
    roles: ["general_chat", "exam_revision"],
    enabled: true,
    is_default: false,
    fallback_priority: 4,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "llama_3_3_70b",
    display_name: "Llama 3.3 70B (Free)",
    provider_id: "meta-llama/llama-3.3-70b-instruct:free",
    description: "Meta's flagship open-weights model for creative dialogue, essay assistance, and synthesis.",
    capabilities: ["chat", "creative", "general"],
    roles: ["general_chat"],
    enabled: true,
    is_default: false,
    fallback_priority: 5,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "qwen_2_5_72b",
    display_name: "Qwen 2.5 72B (Free)",
    provider_id: "qwen/qwen-2.5-72b-instruct:free",
    description: "High-speed, multilingual intelligence with strong technical and reasoning performance.",
    capabilities: ["coding", "multilingual", "fast"],
    roles: ["coding_assistant", "general_chat"],
    enabled: true,
    is_default: false,
    fallback_priority: 6,
    managed_by: "system",
    schema_version: 2
  }
];

// Map legacy preference keys to canonical internal keys
const LEGACY_KEY_ALIASES = {
  deepseek: "deepseek_r1",
  qwen: "qwen_2_5_72b",
  llama: "llama_3_3_70b",
  coding: "coding_assistant",
  gemma: "general_chat"
};

const VALID_ROLES = [
  "general_chat",
  "coding_assistant",
  "exam_revision",
  "fast_classifier",
  "security_guardrail",
  "fallback"
];

class ModelRegistryService {
  constructor() {
    this.inMemoryRegistry = new Map(CANONICAL_PRODUCTION_MODELS.map(m => [m.internal_key, { ...m }]));
    this.reconciled = false;
  }

  /**
   * Invalidate the local memory cache
   */
  invalidateCache() {
    memoryRegistryCache = null;
    lastCacheFetchTime = 0;
  }

  /**
   * Idempotent reconciliation: Reconciles stored registry models against canonical production models.
   * - Preserves admin custom additions/edits (is_custom === true or updated_by !== 'system')
   * - Adds missing canonical production models (apodex_mini, security_classifier, etc.)
   * - Corrects outdated provider IDs / display names for uncustomized system entries (e.g. coding_assistant)
   * - Persists updates to Firestore if connected
   */
  async reconcileModels(existingModelsList = []) {
    const existingMap = new Map((existingModelsList || []).map(m => [m.internal_key, { ...m }]));
    const reconciledMap = new Map();
    const batchUpdates = [];

    // 1. Process all canonical models
    for (const canonical of CANONICAL_PRODUCTION_MODELS) {
      const key = canonical.internal_key;
      const existing = existingMap.get(key);

      if (!existing) {
        // Missing model: add it
        const newModel = {
          ...canonical,
          updated_at: new Date().toISOString(),
          managed_by: "system",
          is_custom: false,
          schema_version: 2
        };
        reconciledMap.set(key, newModel);
        batchUpdates.push({ key, record: newModel, isNew: true });
      } else {
        // Check if admin explicitly customized this entry
        const isAdminCustom = existing.is_custom === true || 
          (existing.updated_by && existing.updated_by !== "system" && existing.updated_by !== "bootstrap");

        if (isAdminCustom) {
          // Preserve admin's custom settings completely
          reconciledMap.set(key, existing);
        } else {
          // System-managed model: check if provider_id, display_name or roles need reconciliation
          const needsUpdate = existing.provider_id !== canonical.provider_id ||
            existing.display_name !== canonical.display_name ||
            existing.schema_version !== 2 ||
            !existing.capabilities ||
            existing.capabilities.length === 0;

          if (needsUpdate) {
            const updatedModel = {
              ...existing,
              display_name: canonical.display_name,
              provider_id: canonical.provider_id,
              description: canonical.description,
              capabilities: canonical.capabilities,
              roles: canonical.roles,
              fallback_priority: canonical.fallback_priority,
              is_default: canonical.is_default,
              schema_version: 2,
              managed_by: "system",
              is_custom: false,
              updated_at: new Date().toISOString()
            };
            reconciledMap.set(key, updatedModel);
            batchUpdates.push({ key, record: updatedModel, isNew: false });
          } else {
            reconciledMap.set(key, existing);
          }
        }
      }
    }

    // 2. Preserve any custom models created by admins that aren't in canonical list
    for (const [key, model] of existingMap.entries()) {
      if (!reconciledMap.has(key)) {
        // Keep existing custom / user-defined models
        reconciledMap.set(key, model);
      }
    }

    // 3. Persist batch updates to Firestore if connected
    if (batchUpdates.length > 0 && db && typeof db.collection === 'function') {
      try {
        const batch = db.batch();
        for (const update of batchUpdates) {
          const docRef = db.collection('model_registry').doc(update.key);
          batch.set(docRef, update.record, { merge: true });
        }
        await batch.commit();
        log.info({ updateCount: batchUpdates.length }, '[ModelRegistry] Reconciled and updated models in Firestore');
      } catch (err) {
        log.warn({ err: err.message }, '[ModelRegistry] Firestore batch reconciliation error (falling back to in-memory)');
      }
    }

    // 4. Update in-memory registry
    this.inMemoryRegistry = reconciledMap;
    this.reconciled = true;
    return Array.from(reconciledMap.values());
  }

  /**
   * Load all models from Firestore (with fallback to in-memory)
   */
  async getAllModels({ enabledOnly = false } = {}) {
    const now = Date.now();
    if (this.reconciled && memoryRegistryCache && (now - lastCacheFetchTime < CACHE_TTL_MS)) {
      return this._filterModels(memoryRegistryCache, enabledOnly);
    }

    try {
      if (db && typeof db.collection === 'function') {
        const snapshot = await db.collection('model_registry').get();
        if (!snapshot.empty) {
          const models = [];
          snapshot.forEach(doc => {
            const data = doc.data();
            models.push({
              internal_key: doc.id,
              ...data
            });
          });

          // Run reconciliation once on load to guarantee accuracy
          const reconciledModels = this.reconciled 
            ? models 
            : await this.reconcileModels(models);

          memoryRegistryCache = reconciledModels;
          lastCacheFetchTime = now;
          return this._filterModels(reconciledModels, enabledOnly);
        } else {
          // Collection is empty: seed it with canonical production models
          const seeded = await this.reconcileModels([]);
          memoryRegistryCache = seeded;
          lastCacheFetchTime = now;
          return this._filterModels(seeded, enabledOnly);
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, '[ModelRegistry] Firestore fetch unavailable, using in-memory registry');
    }

    // Fallback to in-memory registry
    if (!this.reconciled) {
      await this.reconcileModels(Array.from(this.inMemoryRegistry.values()));
    }

    const models = Array.from(this.inMemoryRegistry.values());
    memoryRegistryCache = models;
    lastCacheFetchTime = now;
    return this._filterModels(models, enabledOnly);
  }

  _filterModels(models, enabledOnly) {
    if (!enabledOnly) return [...models];
    return models.filter(m => m.enabled === true);
  }

  /**
   * Get a single model by internal_key (normalizing legacy keys)
   */
  async getModelByKey(key) {
    if (!key) return null;
    const normalizedKey = LEGACY_KEY_ALIASES[key] || key;
    const all = await this.getAllModels({ enabledOnly: false });
    return all.find(m => m.internal_key === normalizedKey) || null;
  }

  /**
   * Resolve authoritative model for an application role
   */
  async resolveModelForRole(role) {
    const all = await this.getAllModels({ enabledOnly: true });
    // 1. Look for enabled model with this role and is_default = true
    let match = all.find(m => Array.isArray(m.roles) && m.roles.includes(role) && m.is_default);
    if (!match) {
      // 2. Look for any enabled model with this role
      match = all.find(m => Array.isArray(m.roles) && m.roles.includes(role));
    }
    if (!match) {
      // 3. Fallback to general_chat or fallback_model
      match = all.find(m => m.internal_key === "general_chat") || all.find(m => m.internal_key === "fallback_model") || all[0];
    }
    return match || CANONICAL_PRODUCTION_MODELS[0];
  }

  /**
   * Build an ordered candidate chain of OpenRouter provider IDs
   * @param {string} role - application role (e.g. 'general_chat', 'coding_assistant', 'exam_revision')
   * @param {string} [userChoiceKey] - user's preferred internal_key from settings (optional)
   * @returns {Promise<string[]>} array of provider_id strings
   */
  async buildCandidateChain(role = "general_chat", userChoiceKey = null) {
    const all = await this.getAllModels({ enabledOnly: true });
    const candidates = [];

    // Normalize legacy user preference keys (e.g. 'deepseek' -> 'deepseek_r1')
    const normalizedUserKey = (userChoiceKey && LEGACY_KEY_ALIASES[userChoiceKey])
      ? LEGACY_KEY_ALIASES[userChoiceKey]
      : userChoiceKey;

    // 1. User Choice override (if valid and enabled)
    if (normalizedUserKey && normalizedUserKey !== "auto") {
      const preferred = all.find(m => m.internal_key === normalizedUserKey && m.enabled);
      if (preferred && preferred.provider_id) {
        candidates.push(preferred.provider_id);
      }
    }

    // 2. Default model for this role
    const roleDefault = await this.resolveModelForRole(role);
    if (roleDefault && roleDefault.provider_id && !candidates.includes(roleDefault.provider_id)) {
      candidates.push(roleDefault.provider_id);
    }

    // 3. Fallback models ordered by fallback_priority
    const fallbacks = all
      .filter(m => (Array.isArray(m.roles) && m.roles.includes("fallback")) || m.internal_key === "fallback_model" || m.internal_key === "apodex_mini")
      .sort((a, b) => (a.fallback_priority || 99) - (b.fallback_priority || 99));

    for (const fb of fallbacks) {
      if (fb.provider_id && !candidates.includes(fb.provider_id)) {
        candidates.push(fb.provider_id);
      }
    }

    // 4. Ensure at least one fallback exists
    if (candidates.length === 0) {
      candidates.push("google/gemma-4-31b-it:free", "cohere/north-mini-code:free", "google/gemma-4-26b-a4b-it:free", "apodex/apodex-1.1-mini:free");
    }

    return candidates;
  }

  /**
   * Check if a given provider_id is authorized by the registry
   */
  async isAuthorizedModel(providerId) {
    if (!providerId) return false;
    const all = await this.getAllModels({ enabledOnly: true });
    return all.some(m => m.provider_id === providerId);
  }

  /**
   * Validate model data before saving
   */
  validateModelData(data, isNew = false) {
    const errors = [];
    if (isNew) {
      if (!data.internal_key || typeof data.internal_key !== 'string' || !/^[a-z0-9_]{2,40}$/.test(data.internal_key)) {
        errors.push("Internal key must be 2-40 characters lowercase alphanumeric and underscores only.");
      }
    }

    if (!data.display_name || typeof data.display_name !== 'string' || data.display_name.trim().length < 2) {
      errors.push("Display name must be at least 2 characters.");
    }

    if (!data.provider_id || typeof data.provider_id !== 'string' || !data.provider_id.includes('/')) {
      errors.push("OpenRouter model ID must follow the 'organization/model-name[:variant]' format.");
    }

    if (data.roles && !Array.isArray(data.roles)) {
      errors.push("Roles must be an array of application roles.");
    }

    return errors;
  }

  /**
   * Save (create or update) a model configuration
   */
  async saveModel(data, adminUser = null) {
    const isNew = !data.is_edit;
    const key = (data.internal_key || "").trim();
    if (!key) throw new Error("Internal key is required.");

    const existing = await this.getModelByKey(key);
    if (isNew && existing) {
      throw new Error(`A model with internal key '${key}' already exists.`);
    }

    // Merge with existing record if editing
    const mergedData = (!isNew && existing) ? { ...existing, ...data } : { ...data };
    mergedData.internal_key = key;

    const validationErrors = this.validateModelData(mergedData, isNew);
    if (validationErrors.length > 0) {
      throw new Error(validationErrors.join(" "));
    }

    const cleanRoles = Array.isArray(mergedData.roles) 
      ? mergedData.roles.filter(r => VALID_ROLES.includes(r))
      : ["general_chat"];

    if (cleanRoles.length === 0) {
      cleanRoles.push("general_chat");
    }

    const cleanCapabilities = Array.isArray(mergedData.capabilities)
      ? mergedData.capabilities.map(c => String(c).trim()).filter(Boolean)
      : (typeof mergedData.capabilities === 'string' ? mergedData.capabilities.split(',').map(c => c.trim()).filter(Boolean) : ["chat"]);

    const modelRecord = {
      internal_key: key,
      display_name: String(mergedData.display_name).trim(),
      provider_id: String(mergedData.provider_id).trim(),
      description: (mergedData.description || "").trim(),
      capabilities: cleanCapabilities,
      roles: cleanRoles,
      enabled: mergedData.enabled !== false,
      is_default: Boolean(mergedData.is_default),
      fallback_priority: Number.isInteger(Number(mergedData.fallback_priority)) ? Number(mergedData.fallback_priority) : 1,
      is_custom: true, // Explicitly marked as admin-managed
      managed_by: "admin",
      updated_at: new Date().toISOString(),
      updated_by: adminUser?.email || adminUser?.uid || "admin"
    };

    // If marked default for a role, unset is_default for other models in the same role
    if (modelRecord.is_default) {
      await this._unsetOtherDefaults(key, cleanRoles);
    }

    // Persist to Firestore
    try {
      if (db && typeof db.collection === 'function') {
        const docRef = db.collection('model_registry').doc(key);
        await docRef.set(modelRecord, { merge: true });
      }
    } catch (err) {
      log.warn({ err: err.message }, '[ModelRegistry] Firestore write failed, updating in-memory only');
    }

    // Update in-memory registry
    this.inMemoryRegistry.set(key, modelRecord);
    this.invalidateCache();

    log.info({ key, provider_id: modelRecord.provider_id, admin: modelRecord.updated_by }, '[ModelRegistry] Saved model configuration');
    return modelRecord;
  }

  async _unsetOtherDefaults(currentKey, roles) {
    try {
      const all = await this.getAllModels({ enabledOnly: false });
      for (const m of all) {
        if (m.internal_key !== currentKey && m.is_default) {
          const sharesRole = Array.isArray(m.roles) && m.roles.some(r => roles.includes(r));
          if (sharesRole) {
            m.is_default = false;
            m.updated_at = new Date().toISOString();
            this.inMemoryRegistry.set(m.internal_key, m);
            if (db && typeof db.collection === 'function') {
              await db.collection('model_registry').doc(m.internal_key).update({
                is_default: false,
                updated_at: m.updated_at
              }).catch(() => {});
            }
          }
        }
      }
    } catch (e) {
      // ignore non-critical default unsetting error
    }
  }

  /**
   * Delete a model from registry
   */
  async deleteModel(key, adminUser = null) {
    if (!key) throw new Error("Missing model key.");
    const existing = await this.getModelByKey(key);
    if (!existing) {
      throw new Error(`Model '${key}' not found.`);
    }

    if (existing.is_default) {
      throw new Error(`Cannot delete '${existing.display_name}' because it is configured as the active default for role(s): ${existing.roles.join(', ')}. Please assign another default first.`);
    }

    // Remove from Firestore
    try {
      if (db && typeof db.collection === 'function') {
        await db.collection('model_registry').doc(key).delete();
      }
    } catch (err) {
      log.warn({ err: err.message }, '[ModelRegistry] Firestore delete failed');
    }

    // Remove from in-memory
    this.inMemoryRegistry.delete(key);
    this.invalidateCache();

    log.info({ key, admin: adminUser?.email }, '[ModelRegistry] Model deleted');
    return { success: true, key };
  }

  /**
   * Test an OpenRouter model connection using minimal ping
   */
  async testModelConnection(providerId, apiKey) {
    if (!providerId) throw new Error("Provider model ID is required.");
    if (!apiKey) throw new Error("OpenRouter API key is not configured on the server.");

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://aadirishi.in/",
          "X-Title": "StudyMate AI Model Test"
        },
        body: JSON.stringify({
          model: providerId,
          messages: [{ role: "user", content: "Ping: Respond with 1 word 'Ready'." }],
          max_tokens: 5,
          provider: { allow_fallbacks: false }
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      const latencyMs = Date.now() - startTime;

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return {
          ok: false,
          status: res.status,
          latencyMs,
          error: `OpenRouter returned HTTP ${res.status}: ${errText.slice(0, 200)}`
        };
      }

      const json = await res.json();
      const reply = json.choices?.[0]?.message?.content?.trim() || "OK";
      return {
        ok: true,
        status: res.status,
        latencyMs,
        reply,
        model: providerId
      };
    } catch (err) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - startTime;
      const isTimeout = err.name === "AbortError";
      return {
        ok: false,
        status: isTimeout ? 408 : 500,
        latencyMs,
        error: isTimeout ? "Connection timed out after 12 seconds." : (err.message || "Network error")
      };
    }
  }
}

const modelRegistryInstance = new ModelRegistryService();
modelRegistryInstance.CANONICAL_PRODUCTION_MODELS = CANONICAL_PRODUCTION_MODELS;
modelRegistryInstance.BOOTSTRAP_MODELS = CANONICAL_PRODUCTION_MODELS;
modelRegistryInstance.LEGACY_KEY_ALIASES = LEGACY_KEY_ALIASES;
modelRegistryInstance.VALID_ROLES = VALID_ROLES;

module.exports = modelRegistryInstance;
