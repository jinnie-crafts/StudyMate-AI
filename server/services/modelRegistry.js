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

// Authoritative Production Models — Strictly locked to 4 approved OpenRouter models
const CANONICAL_PRODUCTION_MODELS = [
  {
    internal_key: "general_chat",
    display_name: "Gemma 4 31B (Free)",
    provider_id: "google/gemma-4-31b-it:free",
    description: "Google's balanced high-capability model for everyday study, conceptual explanations, reasoning, and exam preparation.",
    capabilities: ["chat", "general", "reasoning", "exam", "revision"],
    roles: ["general_chat", "exam_revision"],
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
    internal_key: "fallback_model",
    display_name: "Gemma 4 26B A4B (Free)",
    provider_id: "google/gemma-4-26b-a4b-it:free",
    description: "Reliable fallback model used when primary endpoints experience rate limits or downtime.",
    capabilities: ["fallback", "general"],
    roles: ["fallback", "security_guardrail"],
    enabled: true,
    is_default: false,
    fallback_priority: 2,
    managed_by: "system",
    schema_version: 2
  },
  {
    internal_key: "apodex_mini",
    display_name: "Apodex 1.1 Mini (Free)",
    provider_id: "apodex/apodex-1.1-mini:free",
    description: "Ultra-fast lightweight fallback engine for rapid response, intent detection, and failover continuity.",
    capabilities: ["fallback", "fast", "general"],
    roles: ["fallback", "fast_classifier"],
    enabled: true,
    is_default: false,
    fallback_priority: 3,
    managed_by: "system",
    schema_version: 2
  }
];

const APPROVED_MODEL_KEYS = new Set([
  "general_chat",
  "coding_assistant",
  "fallback_model",
  "apodex_mini"
]);

const APPROVED_PROVIDER_IDS = new Set([
  "google/gemma-4-31b-it:free",
  "cohere/north-mini-code:free",
  "google/gemma-4-26b-a4b-it:free",
  "apodex/apodex-1.1-mini:free"
]);

const APPROVED_KEY_TO_PROVIDER = {
  general_chat: "google/gemma-4-31b-it:free",
  coding_assistant: "cohere/north-mini-code:free",
  fallback_model: "google/gemma-4-26b-a4b-it:free",
  apodex_mini: "apodex/apodex-1.1-mini:free"
};

// Map legacy preference keys to canonical internal keys
const LEGACY_KEY_ALIASES = {
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

const VALID_ROLES = [
  "general_chat",
  "coding_assistant",
  "exam_revision",
  "fast_classifier",
  "security_guardrail",
  "fallback"
];

const USER_SELECTABLE_ROLES = [
  "general_chat",
  "coding_assistant"
];

const INTERNAL_ONLY_ROLES = [
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
   * Idempotent reconciliation: Reconciles stored registry models against the 4 canonical models.
   * - Enforces approved provider IDs locked to whitelist
   * - Purges obsolete models (deepseek_r1, llama_3_3_70b, qwen_2_5_72b, etc.)
   * - Persists updates and deletions to Firestore if connected
   */
  async reconcileModels(existingModelsList = []) {
    const existingMap = new Map((existingModelsList || []).map(m => [m.internal_key, { ...m }]));
    const reconciledMap = new Map();
    const batchUpdates = [];
    const obsoleteDocsToDelete = [];

    // 1. Process all approved canonical models
    for (const canonical of CANONICAL_PRODUCTION_MODELS) {
      const key = canonical.internal_key;
      const existing = existingMap.get(key);

      if (!existing) {
        // Missing canonical model: add it
        const newModel = {
          ...canonical,
          updated_at: new Date().toISOString(),
          managed_by: "system",
          is_custom: false,
          schema_version: 2
        };
        reconciledMap.set(key, newModel);
        batchUpdates.push({ key, record: newModel });
      } else {
        // Enforce approved provider_id whitelist strictly
        const providerId = APPROVED_KEY_TO_PROVIDER[key] || canonical.provider_id;
        const reconciledModel = {
          ...canonical,
          display_name: existing.display_name || canonical.display_name,
          description: existing.description !== undefined ? existing.description : canonical.description,
          provider_id: providerId, // Locked to approved provider ID
          roles: Array.isArray(existing.roles) && existing.roles.length > 0 ? existing.roles : canonical.roles,
          capabilities: Array.isArray(existing.capabilities) && existing.capabilities.length > 0 ? existing.capabilities : canonical.capabilities,
          fallback_priority: existing.fallback_priority !== undefined ? Number(existing.fallback_priority) : canonical.fallback_priority,
          is_default: existing.is_default !== undefined ? Boolean(existing.is_default) : canonical.is_default,
          enabled: existing.enabled !== undefined ? Boolean(existing.enabled) : canonical.enabled,
          schema_version: 2,
          managed_by: existing.managed_by || "system",
          updated_at: new Date().toISOString()
        };
        reconciledMap.set(key, reconciledModel);
        batchUpdates.push({ key, record: reconciledModel });
      }
    }

    // 2. Identify any obsolete/unapproved models to purge
    for (const [key] of existingMap.entries()) {
      if (!APPROVED_MODEL_KEYS.has(key)) {
        obsoleteDocsToDelete.push(key);
      }
    }

    // 3. Persist batch updates and deletions to Firestore if connected
    if (db && typeof db.collection === 'function') {
      try {
        const batch = db.batch();
        for (const update of batchUpdates) {
          const docRef = db.collection('model_registry').doc(update.key);
          batch.set(docRef, update.record, { merge: true });
        }
        for (const delKey of obsoleteDocsToDelete) {
          const docRef = db.collection('model_registry').doc(delKey);
          batch.delete(docRef);
        }
        await batch.commit();
        log.info({ updateCount: batchUpdates.length, deletedCount: obsoleteDocsToDelete.length },
          '[ModelRegistry] Reconciled 4 whitelist models and purged obsolete models from Firestore');
      } catch (err) {
        log.warn({ err: err.message }, '[ModelRegistry] Firestore batch reconciliation error (falling back to in-memory)');
      }
    }

    // 4. Update in-memory registry strictly with the 4 approved models
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
    if (!VALID_ROLES.includes(role)) {
      log.warn({ role }, '[ModelRegistry] Attempted to resolve unrecognized role, falling back to general_chat');
      role = 'general_chat';
    }

    const all = await this.getAllModels({ enabledOnly: true });

    if (role === 'coding_assistant') {
      const coding = all.find(m => m.internal_key === 'coding_assistant');
      if (coding) return coding;
    }
    if (role === 'general_chat' || role === 'exam_revision') {
      const general = all.find(m => m.internal_key === 'general_chat');
      if (general) return general;
    }
    if (role === 'fast_classifier') {
      const fast = all.find(m => m.internal_key === 'apodex_mini') ||
                   all.find(m => m.internal_key === 'fallback_model') ||
                   all.find(m => m.internal_key === 'general_chat');
      if (fast) return fast;
    }
    if (role === 'security_guardrail') {
      const security = all.find(m => m.internal_key === 'fallback_model') ||
                       all.find(m => m.internal_key === 'general_chat');
      if (security) return security;
    }
    if (role === 'fallback') {
      const fb = all.find(m => m.internal_key === 'fallback_model') ||
                 all.find(m => m.internal_key === 'apodex_mini') ||
                 all.find(m => m.internal_key === 'general_chat');
      if (fb) return fb;
    }

    return all.find(m => m.internal_key === 'general_chat') || CANONICAL_PRODUCTION_MODELS[0];
  }

  /**
   * Build an ordered candidate chain of OpenRouter provider IDs.
   * Ensures:
   * - User choices are verified against permitted roles and enabled status.
   * - Internal roles (fast_classifier, security_guardrail) cannot be user-selected.
   * - Role default model is included.
   * - Fallback models are ordered by fallback_priority.
   * - Disabled models are excluded.
   * - Only approved whitelist provider IDs are returned.
   * 
   * @param {string} role - application role (e.g. 'general_chat', 'coding_assistant', 'exam_revision')
   * @param {string} [userChoiceKey] - user's preferred internal_key or provider_id from settings
   * @returns {Promise<string[]>} array of provider_id strings
   */
  async buildCandidateChain(role = "general_chat", userChoiceKey = null) {
    const effectiveRole = VALID_ROLES.includes(role) ? role : "general_chat";
    const all = await this.getAllModels({ enabledOnly: true });
    const candidates = [];

    // Normalize legacy user preference keys (e.g. 'deepseek' -> 'general_chat')
    const normalizedUserKey = (userChoiceKey && LEGACY_KEY_ALIASES[userChoiceKey])
      ? LEGACY_KEY_ALIASES[userChoiceKey]
      : userChoiceKey;

    // 1. User Choice override (if provided, valid, enabled, and permitted for this role)
    if (normalizedUserKey && normalizedUserKey !== "auto") {
      const preferred = all.find(m =>
        (m.internal_key === normalizedUserKey || m.provider_id === normalizedUserKey) && m.enabled
      );

      if (preferred && preferred.provider_id && APPROVED_PROVIDER_IDS.has(preferred.provider_id)) {
        const isFallbackOnly = preferred.internal_key === 'fallback_model' || preferred.internal_key === 'apodex_mini';
        const hasRequestedRole = Array.isArray(preferred.roles) && (preferred.roles.includes(effectiveRole) || (effectiveRole === 'exam_revision' && preferred.roles.includes('general_chat')));

        if (!isFallbackOnly && hasRequestedRole) {
          candidates.push(preferred.provider_id);
          log.info({ role: effectiveRole, userChoice: normalizedUserKey, provider_id: preferred.provider_id },
            '[ModelRegistry] User model choice validated and prioritized in candidate chain');
        } else {
          log.warn({ role: effectiveRole, userChoice: normalizedUserKey, preferredRoles: preferred.roles },
            '[ModelRegistry] User model choice not permitted for role — ignoring preference');
        }
      } else {
        log.warn({ role: effectiveRole, userChoice: normalizedUserKey },
          '[ModelRegistry] User preferred model not found or disabled in registry');
      }
    }

    // 2. Default model for this role
    const roleDefault = await this.resolveModelForRole(effectiveRole);
    if (roleDefault && roleDefault.provider_id && !candidates.includes(roleDefault.provider_id)) {
      candidates.push(roleDefault.provider_id);
    }

    // 3. Fallback models ordered by fallback_priority (fallback_model then apodex_mini)
    const fallbacks = all
      .filter(m => m.internal_key === "fallback_model" || m.internal_key === "apodex_mini" || (Array.isArray(m.roles) && m.roles.includes("fallback")))
      .sort((a, b) => (a.fallback_priority || 99) - (b.fallback_priority || 99));

    for (const fb of fallbacks) {
      if (fb.provider_id && APPROVED_PROVIDER_IDS.has(fb.provider_id) && !candidates.includes(fb.provider_id)) {
        candidates.push(fb.provider_id);
      }
    }

    // 4. Safe recovery if candidates list is empty
    if (candidates.length === 0) {
      log.error({ role: effectiveRole }, '[ModelRegistry] No enabled candidates found, loading canonical defaults');
      candidates.push(CANONICAL_PRODUCTION_MODELS[0].provider_id);
    }

    // Strict whitelist: candidates can only consist of approved provider IDs
    return [...new Set(candidates.filter(id => APPROVED_PROVIDER_IDS.has(id)))];
  }

  /**
   * Check if a given provider_id is authorized by the registry.
   * Optionally verifies authorization for a specific application role.
   */
  async isAuthorizedModel(providerId, role = null) {
    if (!providerId || !APPROVED_PROVIDER_IDS.has(providerId)) return false;
    const all = await this.getAllModels({ enabledOnly: true });
    const matching = all.filter(m => (m.provider_id === providerId || m.internal_key === providerId) && m.enabled === true);
    if (matching.length === 0) return false;

    if (role) {
      if (INTERNAL_ONLY_ROLES.includes(role)) {
        return matching.some(m => Array.isArray(m.roles) && m.roles.includes(role));
      }
      if (matching.some(m => Array.isArray(m.roles) && (m.roles.includes('fallback') || m.internal_key.includes('fallback')))) {
        return true;
      }
      return matching.some(m => Array.isArray(m.roles) && (m.roles.includes(role) || (role === 'exam_revision' && m.roles.includes('general_chat'))));
    }

    return true;
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
  /**
   * Save (update) a model configuration.
   * Creation of new unapproved model keys is strictly disallowed.
   * Provider IDs are locked to the approved whitelist.
   */
  async saveModel(data, adminUser = null) {
    const isNew = !data.is_edit;
    const key = (data.internal_key || "").trim();
    if (!key) throw new Error("Internal key is required.");

    // Strict whitelist: Only the 4 approved models can exist
    if (!APPROVED_MODEL_KEYS.has(key)) {
      throw new Error(`Model creation is restricted. Only the 4 approved models (${Array.from(APPROVED_MODEL_KEYS).join(', ')}) are permitted in the registry.`);
    }

    const existing = await this.getModelByKey(key);
    if (isNew && existing) {
      throw new Error(`A model with internal key '${key}' already exists.`);
    }

    // Merge with existing record if editing
    const mergedData = (!isNew && existing) ? { ...existing, ...data } : { ...data };
    mergedData.internal_key = key;

    // Lock provider ID to approved whitelist value
    const approvedProviderId = APPROVED_KEY_TO_PROVIDER[key];
    if (mergedData.provider_id && mergedData.provider_id.trim() !== approvedProviderId) {
      throw new Error(`Provider ID for '${key}' is locked to '${approvedProviderId}'. Custom provider IDs cannot bypass whitelist.`);
    }
    mergedData.provider_id = approvedProviderId;

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
      provider_id: approvedProviderId,
      description: (mergedData.description || "").trim(),
      capabilities: cleanCapabilities,
      roles: cleanRoles,
      enabled: mergedData.enabled !== false,
      is_default: Boolean(mergedData.is_default),
      fallback_priority: Number.isInteger(Number(mergedData.fallback_priority)) ? Number(mergedData.fallback_priority) : 1,
      is_custom: true,
      managed_by: "admin",
      schema_version: 2,
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
    try {
      const aiService = require('./aiService');
      aiService.failureTracker.delete(modelRecord.provider_id);
    } catch (e) {}

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
   * Delete a model from registry.
   * Whitelist models are protected from deletion.
   */
  async deleteModel(key, adminUser = null) {
    if (!key) throw new Error("Missing model key.");
    const existing = await this.getModelByKey(key);
    if (!existing) {
      throw new Error(`Model '${key}' not found.`);
    }

    if (APPROVED_MODEL_KEYS.has(key)) {
      throw new Error(`Cannot delete '${existing.display_name}'. The 4 whitelist models cannot be deleted from the system. You may disable this model instead.`);
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
    try {
      const aiService = require('./aiService');
      aiService.failureTracker.delete(existing.provider_id);
    } catch (e) {}

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
modelRegistryInstance.APPROVED_MODEL_KEYS = APPROVED_MODEL_KEYS;
modelRegistryInstance.APPROVED_PROVIDER_IDS = APPROVED_PROVIDER_IDS;
modelRegistryInstance.APPROVED_KEY_TO_PROVIDER = APPROVED_KEY_TO_PROVIDER;
modelRegistryInstance.LEGACY_KEY_ALIASES = LEGACY_KEY_ALIASES;
modelRegistryInstance.VALID_ROLES = VALID_ROLES;
modelRegistryInstance.USER_SELECTABLE_ROLES = USER_SELECTABLE_ROLES;

module.exports = modelRegistryInstance;
