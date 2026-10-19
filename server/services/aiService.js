/**
 * StudyMate AI — Centralized AI Request Pipeline Service
 * 
 * Single authoritative service for executing AI requests through OpenRouter.
 * Consumes the authoritative Model Registry for candidate chain construction,
 * model authorization, role validation, fallback ordering, and retry tracking.
 */

const modelRegistry = require('./modelRegistry');
const { loggers } = require('./logger');
const log = loggers.server || console;

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes bench time
const PROBE_INTERVAL_MS = 10000; // 10 seconds probe
const failureTracker = new Map(); // model -> { expiry, reason }
let lastProbeTime = 0;

/**
 * Sanitizes messages for OpenRouter / LLM compliance.
 * Normalizes 'ai' -> 'assistant', ensures valid roles and non-empty string content.
 */
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const validRoles = new Set(['system', 'user', 'assistant']);

  return messages
    .filter(m => m && typeof m === 'object' && typeof m.content === 'string')
    .map(m => {
      let role = String(m.role || 'user').toLowerCase();
      if (role === 'ai') role = 'assistant';
      if (!validRoles.has(role)) role = 'user';
      return {
        role,
        content: m.content
      };
    });
}

/**
 * Classifies an error into retryable vs non-retryable.
 */
function classifyProviderError(err, status) {
  const msg = err?.message || '';
  if (status === 401 || status === 403 || msg.includes('401') || msg.includes('403') || msg.includes('PROVIDER_AUTH_ERROR')) {
    return { isRetryable: false, reason: 'PROVIDER_AUTH_ERROR' };
  }
  if (status === 402 || msg.includes('402') || msg.includes('INSUFFICIENT_CREDITS')) {
    return { isRetryable: false, reason: 'INSUFFICIENT_CREDITS' };
  }
  if (status === 429 || msg.includes('429') || msg.includes('RATE_LIMITED')) {
    return { isRetryable: true, reason: 'RATE_LIMITED' };
  }
  if (err?.name === 'AbortError' || msg.includes('Timeout') || msg.includes('REQUEST_TIMEOUT')) {
    return { isRetryable: true, reason: 'REQUEST_TIMEOUT' };
  }
  if (msg.includes('EMPTY_MODEL_RESPONSE')) {
    return { isRetryable: true, reason: 'EMPTY_MODEL_RESPONSE' };
  }
  if (msg.includes('STREAM_ERROR')) {
    return { isRetryable: true, reason: msg };
  }
  return { isRetryable: true, reason: `PROVIDER_ERROR: ${msg}` };
}

class AIService {
  constructor() {
    this.failureTracker = failureTracker;
    this.apiKey = null;
    this.isConfigured = false;
    this.initialized = false;
  }

  /**
   * Initialize the AI service singleton with runtime configuration.
   * Can be safely called multiple times or with options.
   */
  initialize(options = {}) {
    const rawKey = options.apiKey || process.env.OPENROUTER_API_KEY || null;
    this.apiKey = (typeof rawKey === 'string' && rawKey.trim().length > 0) ? rawKey.trim() : null;
    this.isConfigured = Boolean(this.apiKey && !this.apiKey.includes('YOUR_KEY_HERE'));

    if (!this.isConfigured) {
      log.warn('[AIService] OPENROUTER_API_KEY is not configured or is a placeholder. AI completions will require this variable to be set.');
    } else {
      log.info('[AIService] Initialized successfully. Model routing backed by authoritative Model Registry.');
    }
    this.initialized = true;
    return this.isConfigured;
  }

  /**
   * Validates required configuration before request processing.
   */
  validateConfig() {
    const currentKey = this.apiKey || process.env.OPENROUTER_API_KEY;
    const isConfigured = Boolean(currentKey && typeof currentKey === 'string' && currentKey.trim().length > 0 && !currentKey.includes('YOUR_KEY_HERE'));
    if (!isConfigured) {
      return {
        valid: false,
        error: 'AI Service is not configured. OPENROUTER_API_KEY is missing from server environment. Please set OPENROUTER_API_KEY in server/.env or the Render Dashboard.',
        code: 'CONFIG_ERROR',
        missingVariable: 'OPENROUTER_API_KEY'
      };
    }
    return { valid: true };
  }

  /**
   * Filter candidates based on active failure cooldowns with controlled probing.
   */
  filterActiveCandidates(candidateChain, reqId = '') {
    const now = Date.now();
    let eligibleChain = candidateChain.filter(model => {
      const record = failureTracker.get(model);
      if (record && now < record.expiry) {
        const remainingStr = ((record.expiry - now) / 1000).toFixed(1);
        log.info({ reqId, model, reason: record.reason, remainingSec: remainingStr },
          `[Zero-Failure] Skipping benched model: ${model} (${record.reason}, ${remainingStr}s left)`);
        return false;
      }
      return true;
    });

    if (eligibleChain.length === 0 && candidateChain.length > 0) {
      if (now - lastProbeTime > PROBE_INTERVAL_MS) {
        let eligibleProbe = null;
        for (const m of candidateChain) {
          const record = failureTracker.get(m);
          if (!record) { eligibleProbe = m; break; }
          const reason = record.reason || '';
          if (!reason.includes('PROVIDER_AUTH_ERROR') && !reason.includes('INSUFFICIENT_CREDITS')) {
            eligibleProbe = m;
            break;
          }
        }
        if (eligibleProbe) {
          lastProbeTime = now;
          log.info({ reqId, probeModel: eligibleProbe }, `[Zero-Failure] All models benched. Initiating probe on ${eligibleProbe}`);
          eligibleChain = [eligibleProbe];
        }
      }
    }

    return eligibleChain;
  }

  /**
   * Reset cooldown tracker (used in testing or administrative resets)
   */
  clearFailureTracker() {
    failureTracker.clear();
    lastProbeTime = 0;
  }

  /**
   * Get failure tracker state for diagnostics
   */
  getFailureTrackerStatus() {
    const now = Date.now();
    const status = {};
    for (const [model, record] of failureTracker.entries()) {
      if (now < record.expiry) {
        status[model] = {
          reason: record.reason,
          remainingSec: Number(((record.expiry - now) / 1000).toFixed(1))
        };
      }
    }
    return status;
  }

  /**
   * Execute real-time streaming chat completion via OpenRouter with zero-downtime fallbacks.
   * 
   * @param {Object} params
   * @param {string} params.role - Application role ('general_chat', 'coding_assistant', 'exam_revision')
   * @param {string} [params.userChoice] - User model preference key or provider ID
   * @param {Array} params.messages - Chat messages array [{ role, content }]
   * @param {Function} params.onChunk - Callback for each stream token (chunk: string)
   * @param {string} [params.reqId] - Correlation ID for diagnostics
   * @param {number} [params.timeoutMs=25000] - Per-candidate timeout
   * @param {AbortSignal} [params.signal] - Optional external abort signal
   */
  async executeChatStream({
    role = 'general_chat',
    userChoice = null,
    messages = [],
    onChunk,
    reqId = Math.random().toString(36).substring(2, 9),
    timeoutMs = 25000,
    signal = null
  }) {
    const apiKey = this.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      log.fatal({ reqId }, 'OPENROUTER_API_KEY is missing from environment.');
      throw new Error('CONFIG_ERROR: OPENROUTER_API_KEY is not configured on the server. Please set OPENROUTER_API_KEY in server/.env or Render Dashboard.');
    }

    const sanitizedMessages = sanitizeMessages(messages);
    if (sanitizedMessages.length === 0) {
      throw new Error('VALIDATION_ERROR: No valid messages provided.');
    }

    // 1. Build authoritative candidate chain from Model Registry
    const candidateChain = await modelRegistry.buildCandidateChain(role, userChoice);
    log.info({ reqId, role, userChoice, candidateChainCount: candidateChain.length },
      `[REQ-${reqId}] Model candidates resolved from registry: [${candidateChain.join(', ')}]`);

    if (!candidateChain || candidateChain.length === 0) {
      log.error({ reqId, role }, `[REQ-${reqId}] No authorized models configured for role: ${role}`);
      throw new Error(`NO_AUTHORIZED_MODELS: No enabled models registered for role '${role}'.`);
    }

    // 2. Filter candidates by failure cooldown
    const activeCandidates = this.filterActiveCandidates(candidateChain, reqId);
    let fullText = '';
    let success = false;
    let usedModel = '';
    let lastFailureReason = null;

    for (const model of activeCandidates) {
      let streamEventsParsed = 0;
      let contentTokensReceived = 0;
      const modelStartTime = Date.now();

      // Preflight safety verification
      const isAuthorized = await modelRegistry.isAuthorizedModel(model, role);
      if (!isAuthorized) {
        log.warn({ reqId, model, role }, `[REQ-${reqId}] Skipping candidate not authorized for role: ${model}`);
        continue;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      // Link external signal if provided
      const abortHandler = () => controller.abort();
      if (signal) signal.addEventListener('abort', abortHandler, { once: true });

      try {
        log.info({ reqId, model }, `[REQ-${reqId}] [Streaming] Attempting model: ${model}`);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://aadirishi.in/',
            'X-Title': 'StudyMate AI'
          },
          body: JSON.stringify({
            model,
            messages: sanitizedMessages,
            stream: true,
            provider: { allow_fallbacks: false }
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortHandler);

        if (!response.ok) {
          const rawError = await response.text().catch(() => '');
          log.warn({ reqId, model, status: response.status, rawError: rawError.slice(0, 200) },
            `[REQ-${reqId}] OpenRouter HTTP ${response.status}`);
          const classified = classifyProviderError(new Error(rawError), response.status);
          if (!classified.isRetryable) {
            // Non-retryable configuration failure (e.g. invalid key)
            throw new Error(`${classified.reason}: ${rawError}`);
          }
          throw new Error(`HTTP ${response.status}: ${rawError}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstChunk = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const cleanedLine = line.trim();
            if (cleanedLine.startsWith('data: ')) {
              const dataStr = cleanedLine.slice(6).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const data = JSON.parse(dataStr);
                streamEventsParsed++;

                if (data.error) {
                  log.warn({ reqId, model, err: data.error }, `[REQ-${reqId}] Stream payload error from OpenRouter`);
                  throw new Error(`STREAM_ERROR: ${data.error.message || 'Unknown stream error'}`);
                }

                const content = data.choices?.[0]?.delta?.content;
                if (content !== undefined && content !== null) {
                  if (firstChunk && content) {
                    firstChunk = false;
                    success = true;
                    usedModel = model;
                    failureTracker.delete(model);
                    log.info({ reqId, model }, `[REQ-${reqId}] Model verified and generating stream content`);
                  }
                  if (content) {
                    contentTokensReceived++;
                    fullText += content;
                    if (typeof onChunk === 'function') {
                      onChunk(content);
                    }
                  }
                }
              } catch (parseErr) {
                if (parseErr.message.startsWith('STREAM_ERROR')) throw parseErr;
              }
            }
          }
        }

        if (success && contentTokensReceived > 0) {
          log.info({ reqId, model, tokens: contentTokensReceived, elapsedMs: Date.now() - modelStartTime },
            `[REQ-${reqId}] Stream completed successfully with model: ${model}`);
          break;
        }

        if (!success || contentTokensReceived === 0) {
          throw new Error('EMPTY_MODEL_RESPONSE');
        }

      } catch (err) {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortHandler);

        const elapsed = Date.now() - modelStartTime;
        const classified = classifyProviderError(err, 0);
        lastFailureReason = classified.reason;

        log.warn({ reqId, model, reason: lastFailureReason, elapsedMs: elapsed, err: err.message },
          `[REQ-${reqId}] Model failure on candidate ${model}`);

        if (!classified.isRetryable) {
          // Hard error: abort chain
          throw err;
        }

        failureTracker.set(model, {
          expiry: Date.now() + COOLDOWN_MS,
          reason: lastFailureReason
        });
      }
    }

    return {
      success,
      usedModel: success ? usedModel : 'safe-fallback',
      fullText,
      fallbackReason: success ? null : (lastFailureReason || (activeCandidates.length === 0 ? 'ALL_MODELS_IN_COOLDOWN' : 'UNKNOWN_AI_ERROR'))
    };
  }

  /**
   * Execute JSON-based chat completion via OpenRouter with candidate fallback.
   * 
   * @param {Object} params
   * @param {string} params.role - Application role
   * @param {string} [params.userChoice] - User model preference
   * @param {Array} params.messages - Chat messages array
   * @param {string} [params.reqId] - Request ID
   * @param {number} [params.timeoutMs=15000] - Timeout
   * @param {number} [params.temperature] - Temperature
   * @param {number} [params.maxTokens] - Max tokens
   */
  async executeChatCompletion({
    role = 'general_chat',
    userChoice = null,
    messages = [],
    reqId = Math.random().toString(36).substring(2, 9),
    timeoutMs = 15000,
    temperature = 0.7,
    maxTokens = null,
    responseFormat = null
  }) {
    const apiKey = this.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      log.fatal({ reqId }, 'OPENROUTER_API_KEY is missing from environment.');
      throw new Error('CONFIG_ERROR: OPENROUTER_API_KEY is not configured on the server. Please set OPENROUTER_API_KEY in server/.env or Render Dashboard.');
    }

    const sanitizedMessages = sanitizeMessages(messages);
    if (sanitizedMessages.length === 0) {
      throw new Error('VALIDATION_ERROR: No valid messages provided.');
    }

    const candidateChain = await modelRegistry.buildCandidateChain(role, userChoice);
    if (!candidateChain || candidateChain.length === 0) {
      throw new Error(`NO_AUTHORIZED_MODELS: No enabled models registered for role '${role}'.`);
    }

    const activeCandidates = this.filterActiveCandidates(candidateChain, reqId);
    let lastFailureReason = null;

    for (const model of activeCandidates) {
      const isAuthorized = await modelRegistry.isAuthorizedModel(model, role);
      if (!isAuthorized) continue;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        log.info({ reqId, model, role }, `[REQ-${reqId}] [JSON] Attempting model: ${model}`);

        const requestBody = {
          model,
          messages: sanitizedMessages,
          provider: { allow_fallbacks: false },
          temperature
        };
        if (maxTokens) requestBody.max_tokens = maxTokens;
        if (responseFormat) requestBody.response_format = responseFormat;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://aadirishi.in/',
            'X-Title': 'StudyMate AI'
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const rawError = await response.text().catch(() => '');
          const classified = classifyProviderError(new Error(rawError), response.status);
          if (!classified.isRetryable) {
            throw new Error(`${classified.reason}: ${rawError}`);
          }
          throw new Error(`HTTP ${response.status}: ${rawError}`);
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content || String(content).trim().length === 0) {
          throw new Error('EMPTY_MODEL_RESPONSE');
        }

        failureTracker.delete(model);
        log.info({ reqId, model }, `[REQ-${reqId}] JSON completion succeeded with model: ${model}`);

        return {
          success: true,
          modelUsed: model,
          content: String(content).trim(),
          raw: data
        };

      } catch (err) {
        clearTimeout(timeoutId);
        const classified = classifyProviderError(err, 0);
        lastFailureReason = classified.reason;

        log.warn({ reqId, model, reason: lastFailureReason, err: err.message },
          `[REQ-${reqId}] JSON model candidate failure on ${model}`);

        if (!classified.isRetryable) {
          throw err;
        }

        failureTracker.set(model, {
          expiry: Date.now() + COOLDOWN_MS,
          reason: lastFailureReason
        });
      }
    }

    return {
      success: false,
      modelUsed: 'safe-fallback',
      content: '',
      fallbackReason: lastFailureReason || (activeCandidates.length === 0 ? 'ALL_MODELS_IN_COOLDOWN' : 'UNKNOWN_AI_ERROR')
    };
  }

  /**
   * Direct completion for internal service roles (e.g. security_guardrail, fast_classifier)
   */
  async executeDirectCompletion({
    role = 'fast_classifier',
    providerId = null,
    messages = [],
    reqId = Math.random().toString(36).substring(2, 9),
    timeoutMs = 8000,
    temperature = 0.0,
    maxTokens = 150,
    responseFormat = null
  }) {
    const apiKey = this.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('CONFIG_ERROR: Missing OPENROUTER_API_KEY on server.');
    }

    // Resolve target model
    let targetProviderId = providerId;
    if (!targetProviderId) {
      const resolved = await modelRegistry.resolveModelForRole(role);
      targetProviderId = resolved?.provider_id;
    }

    if (!targetProviderId) {
      throw new Error(`NO_MODEL_FOR_ROLE: Cannot resolve model for internal role '${role}'.`);
    }

    // Validate authorization
    const isAuth = await modelRegistry.isAuthorizedModel(targetProviderId, role);
    if (!isAuth) {
      log.warn({ targetProviderId, role }, '[AIService] Model not authorized for role, verifying globally');
      const isGloballyAuth = await modelRegistry.isAuthorizedModel(targetProviderId);
      if (!isGloballyAuth) {
        throw new Error(`UNAUTHORIZED_MODEL: Model '${targetProviderId}' is not authorized in registry.`);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const requestBody = {
        model: targetProviderId,
        messages: sanitizeMessages(messages),
        provider: { allow_fallbacks: false },
        temperature,
        max_tokens: maxTokens
      };
      if (responseFormat) requestBody.response_format = responseFormat;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://aadirishi.in/',
          'X-Title': 'StudyMate AI Internal'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        throw new Error(`OpenRouter HTTP ${response.status}: ${raw}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      return {
        success: true,
        modelUsed: targetProviderId,
        content: String(content || '').trim(),
        raw: data
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

const aiServiceInstance = new AIService();
module.exports = aiServiceInstance;
