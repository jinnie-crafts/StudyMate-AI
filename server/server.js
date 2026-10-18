/**
 * StudyMate AI — Backend Proxy
 *
 * Keeps the OpenRouter API key server-side.
 * Frontend calls POST /api/chat → this server → OpenRouter → response back.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const { loggers } = require("./services/logger");
const log = loggers.server;

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const AgentRunner = require("./agents");
const ragRunner = require("./rag/ragRunner");  // RAG Pipeline Integration
const memoryRunner = require("./memory/memoryRunner"); // Memory System Integration
const kbRoutes = require("./routes/kb"); // Knowledge Base Admin API
const { checkSecurity } = require("./services/security"); // Pre-LLM Security Guardrail
const { requireAuth } = require("./services/authMiddleware"); // Firebase Auth Middleware
const modelRegistry = require("./services/modelRegistry"); // Centralized AI Model Registry

if (!process.env.OPENROUTER_API_KEY) {
  log.fatal("CRITICAL: Missing OPENROUTER_API_KEY in environment.");
}

const REALTIME_QUERY_REGEX = /(today|now|latest|news|current|recent|weather|price|score|stock|time)/i;
const NEWS_QUERY_REGEX = /(news|headlines|breaking|latest news|current affairs)/i;
const CODE_QUERY_REGEX = /code|program|example|debug|script|function|snippet|coding/i;
const MATH_QUERY_REGEX = /math|calculate|solve|equation/i;
const DIAGRAM_QUERY_REGEX = /diagram|chart|graph|flow|flowchart|structure|architecture/i;
const DEFAULT_MODEL = "google/gemma-4-31b-it:free";
const IDENTITY_CLASSIFIER_MODEL = "openrouter/free";

const MODEL_POOL = [
  "google/gemma-4-31b-it:free",
  "cohere/north-mini-code:free",
  "google/gemma-4-26b-a4b-it:free",
  "apodex/apodex-1.1-mini:free"
];

// Model Strategy Constants
const MODELS = {
  GENERAL: "google/gemma-4-31b-it:free",
  LONG_EXPLANATION: "google/gemma-4-31b-it:free",
  CODING: "cohere/north-mini-code:free",
  REASONING: "google/gemma-4-31b-it:free",
  FAST: "google/gemma-4-31b-it:free",
  FALLBACK: "google/gemma-4-26b-a4b-it:free"
};

const failureTracker = new Map(); // model -> { expiry, reason }
const COOLDOWN_MS = 5 * 60 * 1000;
let lastProbeTime = 0;
const PROBE_INTERVAL_MS = 10000;

let lastIdentityIndex = -1;
const IDENTITY_RESPONSES = [
  "StudyMate-AI is developed by Harsh Maurya, Komal Sharma and Ruchii.",
  "This application is created by Harsh Maurya, Komal Sharma and Ruchii.",
  "Harsh Maurya, Komal Sharma and Ruchii are the developers of StudyMate-AI.",
  "StudyMate-AI is built by Harsh Maurya, Komal Sharma and Ruchii."
];
const REALTIME_CACHE_TTL_MS = 5 * 60 * 1000;
const IDENTITY_CACHE_TTL_MS = 30 * 60 * 1000;
const RESPONSE_CACHE_TTL_MS = 5 * 60 * 1000;

const realtimeCache = new Map();
const identityCache = new Map();
const responseCache = new Map();
const MAX_CACHE_SIZE = 500;

// ---------------------------------------------------------------------------
// Prompt Templates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt Templates — loaded from server-side files (VULN-11)
// ---------------------------------------------------------------------------

function loadPromptFile(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, 'prompts', filename), 'utf-8').trim();
  } catch (err) {
    log.error({ err, filename }, 'Failed to load prompt file');
    return '';
  }
}

const PROMPT_TEMPLATES = {
  CHAT: loadPromptFile('chat.md'),
  QUIZ_GEN: `[Role:QuizMaster][Task:1MCQ][Format:Q: | A) | B) | C) | D)] Based on topic.`,
  QUIZ_EVAL: `[Task:EvalAns][Rule:IfOk:Correct!+NextQ.Else:Explain+Retry][Limit:4Lines]`
};

const THINKING_PROMPT = `
Think step-by-step internally.
Do NOT show your thinking.
Only return the final structured answer.
`;

// ---------------------------------------------------------------------------
// Middleware — Security Hardening
// ---------------------------------------------------------------------------

// 1. Request Logging (Must execute first)
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    log.info({ method: req.method, url: req.url, ip: req.ip }, `Request received: ${req.method} ${req.url}`);
  }
  next();
});

// 2. CORS — Load allowed origins from config and set credentials to false
const { allowedOrigins } = require("./config/corsConfig");

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server / same-origin requests (no origin) and allowed origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false); // Reject unauthorized origins cleanly without throwing server error
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: false,
  optionsSuccessStatus: 204
}));

// CORS Origin Validation Middleware for non-preflight requests
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.method !== 'OPTIONS' && origin && !allowedOrigins.includes(origin)) {
    log.warn({ origin, url: req.url }, 'CORS blocked request from unauthorized origin');
    return res.status(403).json({
      error: 'Forbidden',
      message: `Origin '${origin}' is not allowed by CORS configuration.`
    });
  }
  next();
});

// 3. Security Headers — Helmet (VULN-07)
app.use(helmet({
  contentSecurityPolicy: false,       // CSP managed separately for frontend
  crossOriginEmbedderPolicy: false,   // Allow external resources
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// 4. Body parser with size limits
app.use(express.json({ limit: "100kb" }));

// 5. Rate Limiting (VULN-06)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,              // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});

const kbLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many KB requests. Please slow down.' }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests. Please slow down.' }
});

// 6. Apply rate limiters and auth middleware to routes
const { verifyAdmin: kbVerifyAdmin } = require('./services/authMiddleware');
app.use("/api/kb", kbLimiter, kbVerifyAdmin, kbRoutes);
app.use("/api/admin/kb", kbLimiter, kbVerifyAdmin, kbRoutes);
app.use("/api/admin", adminLimiter, require("./routes/admin"));

// 7. Safe Static file serving — Whitelist allowed files and directories (VULN-05)
// Under no circumstances should backend files, environment files, logs, or source code be accessible.
const ALLOWED_STATIC_FILES = new Set([
  'index.html', 'login.html', 'signup.html', 'verify.html', 'settings.html', 'admin.html',
  'privacy.html', 'terms.html', 'recover.html', 'reset.html', '404.html',
  'manifest.json', 'site.webmanifest', 'robots.txt', 'humans.txt', 'ads.txt',
  'sitemap.xml', 'feed.xml', 'rss.xml', 'browserconfig.xml',
  'app.js', 'admin.js', 'verify.js', 'recover.js', 'reset.js', '404.js',
  'style.css', 'skeleton.css', 'admin.css', 'notification.css',
  'notificationBell.js', 'disposableEmailValidator.js', 'adminSecurityLogs.js', 'adminSignupLogs.js',
  'spaNavigation.js', 'modelRegistryClient.js', 'adminModelRegistry.js', 'adminAuthHelper.js',
  'faq.json', 'features.json', 'knowledge.json', 'firebase.js'
]);

const ALLOWED_STATIC_DIRS = ['img', 'config', '.well-known'];

// Clean URLs Middleware for local development parity with Firebase Hosting
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.endsWith('.html') && req.path !== '/index.html') {
    const cleanPath = req.path.slice(0, -5);
    const query = req.url.slice(req.path.length);
    return res.redirect(301, cleanPath + query);
  }
  next();
});

app.use((req, res, next) => {
  // Normalize path to prevent path traversal
  const safePath = path.normalize(req.path).replace(/^(\.\.[\/\\])+/, '');
  const baseName = path.basename(safePath);
  
  // Extract the top-level directory name
  const pathParts = safePath.split(/[/\\]/).filter(Boolean);
  const dirName = pathParts[0];

  // If requesting API routes, bypass static check
  if (req.path.startsWith('/api/')) {
    return next();
  }

  // Allow root path '/'
  if (req.path === '/' || req.path === '/index.html') {
    return next();
  }

  // Check if file is whitelisted (handle clean URLs by checking with .html appended)
  if (ALLOWED_STATIC_FILES.has(baseName) || ALLOWED_STATIC_FILES.has(baseName + '.html')) {
    return next();
  }

  // Check if directory is whitelisted
  if (dirName && ALLOWED_STATIC_DIRS.includes(dirName)) {
    return next();
  }

  // Deny anything else
  log.warn({ path: req.path }, 'Blocked unauthorized static file access attempt');
  res.status(403).send('Forbidden');
});

app.use(express.static(path.join(__dirname, "../"), { extensions: ['html'] }));

app.get("/api/health", async (_req, res) => {
  const firebaseStatus = require('./services/firebaseAdmin');
  const selfTest = await firebaseStatus.performSelfTest();
  
  const isHealthy = firebaseStatus.isInitialized && selfTest.firestore === 'connected' && selfTest.auth === 'connected';
  const isUnhealthy = !firebaseStatus.isInitialized;
  const statusLevel = isHealthy ? 'healthy' : (isUnhealthy ? 'unhealthy' : 'degraded');

  res.json({ 
    status: statusLevel, 
    service: "StudyMate AI Backend",
    firebaseAdmin: firebaseStatus.isInitialized ? "initialized" : "uninitialized",
    firestore: selfTest.firestore,
    authentication: selfTest.auth,
    credentialSource: firebaseStatus.credentialSource || "None",
    uptime: process.uptime(),
    version: process.env.npm_package_version || "1.0.0",
    timestamp: new Date().toISOString()
  });
});

// Public Model Registry endpoint (consumed by Settings and dynamic client selectors)
app.get("/api/models", async (req, res) => {
  try {
    const role = req.query.role || null;
    const models = await modelRegistry.getAllModels({ enabledOnly: true });
    const sanitized = models
      .filter(m => !role || (Array.isArray(m.roles) && m.roles.includes(role)))
      .map(m => ({
        internal_key: m.internal_key,
        display_name: m.display_name,
        provider_id: m.provider_id,
        description: m.description,
        capabilities: m.capabilities,
        roles: m.roles,
        is_default: m.is_default,
        fallback_priority: m.fallback_priority
      }));
    res.json({
      models: sanitized,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log.error({ err }, "GET /api/models error");
    res.status(500).json({ error: "Failed to load model registry" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat — proxy to OpenRouter with fallback
// ---------------------------------------------------------------------------

const MODEL_FALLBACKS = [
  "google/gemma-4-31b-it:free",
  "cohere/north-mini-code:free",
  "google/gemma-4-26b-a4b-it:free",
  "apodex/apodex-1.1-mini:free"
];

const MODEL_TIMEOUT_MS = 25000;

app.post("/api/chat", chatLimiter, requireAuth, async (req, res) => {
  const start = Date.now();
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      log.fatal("OPENROUTER_API_KEY is missing from environment.");
      return res.status(500).json({ error: "AI Service is not configured. Please check server logs." });
    }

    // userId is now ALWAYS derived from verified Firebase token (VULN-08/10)
    const { messages, mode, hinglish, notesMode, userId, doubt = false, currentQuestion = null, userMemory = [] } = req.body;
    log.info({ userId, mode: mode || 'General', msgCount: Array.isArray(messages) ? messages.length : 0 }, 'AI request received');

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No messages provided." });
    }

    // Message validation — prevent resource exhaustion (VULN-26)
    const MAX_MESSAGES = 30;
    const MAX_MSG_LENGTH = 10000;
    if (messages.length > MAX_MESSAGES) {
      return res.status(400).json({ error: `Too many messages. Maximum ${MAX_MESSAGES} allowed.` });
    }
    for (const msg of messages) {
      if (typeof msg.content === 'string' && msg.content.length > MAX_MSG_LENGTH) {
        return res.status(400).json({ error: `Message too long. Maximum ${MAX_MSG_LENGTH} characters per message.` });
      }
    }

    const latestUserMessage = getLatestUserMessage(messages);
    const context = { req, res, userId, mode, doubt, currentQuestion, messages, userMemory };

    // 0. Security Guardrail (CRITICAL — Intercepts malicious administrative prompts)
    const securityResult = await checkSecurity(req, latestUserMessage);
    if (securityResult.blocked) {
      return res.json({
        text: securityResult.refusal,
        reply: securityResult.refusal,
        intent: "security_refusal",
        sources: [],
        model_used: "SecurityAgent",
        cached: false
      });
    }

    // 1. Identity check (CRITICAL — Hardcoded, bypassing AI)
    if (isIdentityQueryMatch(latestUserMessage)) {
      const responseText = getRandomIdentityResponse();
      return res.json({
        text: responseText,
        reply: responseText,
        intent: "identity"
      });
    }

    // 2. Detect intent (Keyword based)
    let intent = detectIntent(latestUserMessage, mode);

    // 3. Mode Normalization
    let normalizedMode = (mode || "general").toLowerCase();
    const validModes = ["general", "coding", "exam"];
    if (!validModes.includes(normalizedMode)) {
      normalizedMode = "general";
    }

    // 4. Intent Override (CRITICAL)
    if (normalizedMode === "coding") {
      intent = "CODING";
    }

    // 5. Select model & authoritative role from Model Registry
    let modelRole = "general_chat";
    if (normalizedMode === "coding") modelRole = "coding_assistant";
    else if (normalizedMode === "exam") modelRole = "exam_revision";

    const userModelChoice = req.body.model_choice || req.body.model || null;
    const authoritativeChain = await modelRegistry.buildCandidateChain(modelRole, userModelChoice);
    const selectedModel = authoritativeChain[0] || selectModel(intent);

    // 6. Check cache (with bypass logic)
    // --- RAG Integration: Use classifier to determine if retrieval is needed ---
    const ragResult = await ragRunner.execute(latestUserMessage, userId);

    // RULE 3: Intercept Missing Knowledge for StudyMate
    if (ragResult.missingKnowledge) {
      return res.json({
        text: "I don't have verified information about that topic in the official StudyMate AI Knowledge Base. If you're the administrator, you can add this information through the Knowledge Base Admin Panel.",
        reply: "I don't have verified information about that topic in the official StudyMate AI Knowledge Base. If you're the administrator, you can add this information through the Knowledge Base Admin Panel.",
        sources: [],
        model_used: "KB-Fallback",
        cached: false
      });
    }

    const isRealtime = ragResult.enhanced; // RAG classifier supersedes old regex
    const cacheKey = generateCacheKey({
      message: latestUserMessage,
      intent,
      userProfile: req.body.userProfile,
      mode: normalizedMode
    });

    if (!isRealtime && !doubt && latestUserMessage.length <= 300) {
      const cached = getCachedResponse(cacheKey);
      if (cached) {
        console.log(`[Cache Hit] Serving: ${cacheKey}`);
        return res.json({
          text: cached.reply,
          reply: cached.reply,
          quiz: cached.quiz,
          sources: [],
          model_used: cached.model_used,
          cached: true
        });
      }
    }

    // --- RAG Integration: Use sources and context from RAG pipeline ---
    let sources = ragResult.sources || [];
    sources = Array.isArray(sources)
      ? sources.filter((src) => (
        src &&
        typeof src.url === "string" &&
        /^https?:\/\//i.test(src.url) &&
        typeof src.title === "string" &&
        src.title.trim()
      ))
      : [];
    sources = sources.slice(0, 5);
    sources = sources.map((src, i) => ({
      title: `🔗 Source ${i + 1}`,
      url: src.url
    }));

    // 5. Build prompt with History Context (Last 5 messages)
    const autoQuestionEnabled = req.body.autoQuestion !== false;
    // --- RAG FIX: Inject formatted context into system prompt (was missing before) ---
    const ragContext = ragResult.promptContext || "";

    // --- MEMORY INTEGRATION ---
    const memoryContext = memoryRunner.retrieveContext(latestUserMessage, userMemory);

    // --- PROMPT DECORATION (Multi-Part, Formatting, Tone) ---
    const promptDecoration = AgentRunner.buildPromptDecoration({
      intent, mode: normalizedMode, message: latestUserMessage
    });

    const systemPrompt = `${buildAgentPrompt(latestUserMessage, intent, normalizedMode, currentQuestion, autoQuestionEnabled, ragResult.kbExactMatch)}${promptDecoration}\n[User Intent: ${intent}]${ragContext ? "\n" + ragContext : ""}${memoryContext ? "\n" + memoryContext : ""}`;

    const finalMessages = [
      { role: "system", content: systemPrompt }
    ];

    // Add session history context (last 5 messages)
    const historyContext = messages.slice(-6, -1); // Exclude the latest user message which we add below
    historyContext.forEach(msg => {
      finalMessages.push({ role: "user", content: msg.content, name: msg.role === "user" ? "User" : "StudyMate" });
    });

    // If evaluating, include the question being answered
    if (intent === "quiz" && currentQuestion) {
      finalMessages.push({ role: "assistant", content: `Q: ${currentQuestion}` });
    }

    finalMessages.push({ role: "user", content: latestUserMessage });

    // 6. Build model chain with cooldown awareness from Centralized Registry
    const now = Date.now();
    let candidateChain = authoritativeChain.filter(model => {
      const record = failureTracker.get(model);
      if (record && now < record.expiry) {
        const remainingStr = ((record.expiry - now) / 1000).toFixed(1);
        console.log(`[Zero-Failure] Skipping benched model: ${model} (Cooling down for ${remainingStr}s, Reason: ${record.reason})`);
        return false;
      }
      return true;
    });

    if (candidateChain.length === 0) {
      if (now - lastProbeTime > PROBE_INTERVAL_MS) {
        const fullChain = authoritativeChain;
        let eligibleProbe = null;
        for (const m of fullChain) {
           const record = failureTracker.get(m);
           if (!record) { eligibleProbe = m; break; }
           const reason = record.reason || "";
           if (!reason.includes("PROVIDER_AUTH_ERROR") && !reason.includes("INSUFFICIENT_CREDITS")) {
              eligibleProbe = m;
              break;
           }
        }
        
        if (eligibleProbe) {
           lastProbeTime = now;
           console.log(`[Zero-Failure] All models benched. Initiating controlled probe on ${eligibleProbe}`);
           candidateChain = [eligibleProbe];
        } else {
           console.log(`[Zero-Failure] All models benched, but no eligible models for probing (hard auth/credit errors).`);
        }
      } else {
        const remainingProbe = ((PROBE_INTERVAL_MS - (now - lastProbeTime)) / 1000).toFixed(1);
        console.log(`[Zero-Failure] All models benched. Probe on cooldown for ${remainingProbe}s.`);
      }
    }

    // 7. Support Streaming if requested
    if (req.body.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no" // Disable buffering for Nginx
      });
      res.flushHeaders();
      // If compression or a proxy is used, they might need an explicit flush
      if (typeof res.flush === "function") res.flush();

      let fullText = "";
      let success = false;
      let usedModel = "";
      let fallbackReason = null;
      const requestId = Math.random().toString(36).substring(2, 9);
      console.log(`[REQ-${requestId}] Chat request initialized. stream=true`);

      for (const model of candidateChain) {
        let streamEventsParsed = 0;
        let contentTokensReceived = 0;
        let doneReceived = false;
        const modelStartTime = Date.now();

        try {
          console.log(`[REQ-${requestId}] [Zero-Failure Streaming] Attempting model: ${model}`);
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

          console.log(`[REQ-${requestId}] Starting OpenRouter fetch request...`);
          const streamResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              "HTTP-Referer": "https://aadirishi.in/",
              "X-Title": "StudyMate AI"
            },
            body: JSON.stringify({
              model,
              messages: finalMessages,
              stream: true,
              provider: { allow_fallbacks: false }
            }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          console.log(`[REQ-${requestId}] Upstream HTTP status: ${streamResponse.status}`);
          if (!streamResponse.ok) {
            const rawError = await streamResponse.text().catch(() => "");
            console.log(`[REQ-${requestId}] Sanitized upstream error: ${rawError.substring(0, 200)}`);
            throw new Error(`HTTP ${streamResponse.status}: ${rawError}`);
          }

          const reader = streamResponse.body;
          const decoder = new TextDecoder();
          const streamReader = reader.getReader();
          let firstChunk = true;
          let buffer = "";

          while (true) {
            const { done, value } = await streamReader.read();
            if (done) {
               console.log(`[REQ-${requestId}] Stream reader done.`);
               break;
            }
            
            if (value && value.length > 0) {
               // console.log(`[REQ-${requestId}] Stream reader received ${value.length} bytes.`);
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const cleanedLine = line.trim();
              if (cleanedLine.startsWith("data: ")) {
                const dataStr = cleanedLine.slice(6).trim();
                if (dataStr === "[DONE]") {
                   doneReceived = true;
                   console.log(`[REQ-${requestId}] Received [DONE] event.`);
                   continue; // Keep processing the rest of the buffer
                }
                
                try {
                  const data = JSON.parse(dataStr);
                  streamEventsParsed++;

                  if (data.error) {
                    console.log(`[REQ-${requestId}] Top-level error in stream:`, JSON.stringify(data.error).substring(0, 100));
                    throw new Error(`STREAM_ERROR: ${data.error.message || "Unknown stream error"}`);
                  }

                  const content = data.choices?.[0]?.delta?.content;
                  
                  if (content !== undefined && content !== null) {
                    if (firstChunk && content) {
                      firstChunk = false;
                      success = true;
                      usedModel = model;
                      failureTracker.delete(model);
                      console.log(`[REQ-${requestId}] Model ${model} marked successful on first content.`);
                    }
                    if (content) {
                      contentTokensReceived++;
                      fullText += content;
                      res.write(`data: ${JSON.stringify({ content })}\n\n`);
                    }
                  }
                } catch (e) {
                  if (e.message.startsWith("STREAM_ERROR")) {
                     throw e; // Bubble up provider stream errors
                  }
                  console.error(`[REQ-${requestId}] Parse error on chunk: ${e.message}`);
                }
              }
            }
          }

          console.log(`[REQ-${requestId}] Finished loop for ${model}. streamEventsParsed=${streamEventsParsed}, contentTokensReceived=${contentTokensReceived}, doneReceived=${doneReceived}, success=${success}`);
          if (success) break;

          // If we finish the stream but never got success=true (e.g. empty response)
          if (!success) {
            throw new Error("EMPTY_MODEL_RESPONSE");
          }
        } catch (error) {
          const elapsed = Date.now() - modelStartTime;
          console.error(`[REQ-${requestId}] FAILURE with ${model} after ${elapsed}ms: ${error.message}`);
          
          if (!fallbackReason) {
            if (error.name === "AbortError") fallbackReason = "REQUEST_TIMEOUT";
            else if (error.message.includes("HTTP 401") || error.message.includes("HTTP 403")) fallbackReason = "PROVIDER_AUTH_ERROR";
            else if (error.message.includes("HTTP 402")) fallbackReason = "INSUFFICIENT_CREDITS";
            else if (error.message.includes("HTTP 429")) fallbackReason = "RATE_LIMITED";
            else if (error.message.includes("STREAM_ERROR")) fallbackReason = error.message;
            else if (error.message.includes("EMPTY_MODEL_RESPONSE")) fallbackReason = "EMPTY_MODEL_RESPONSE";
            else fallbackReason = `PROVIDER_ERROR: ${error.message}`;
            console.log(`[REQ-${requestId}] Fallback reason captured: ${fallbackReason}`);
          }
          failureTracker.set(model, { expiry: Date.now() + COOLDOWN_MS, reason: fallbackReason });
        }
      }

      if (!success) {
        console.warn(`[REQ-${requestId}] CRITICAL: All models failed. Using safe fallback.`);
        if (!fallbackReason) {
            console.log(`[REQ-${requestId}] Branch: candidateChain exhausted, fallbackReason was null.`);
            fallbackReason = candidateChain.length === 0 ? "ALL_MODELS_IN_COOLDOWN" : "UNKNOWN_AI_ERROR";
        }
        console.log(`[REQ-${requestId}] Final fallback reason: ${fallbackReason}`);
        const fallback = getSafeFallbackReply(latestUserMessage, intent);
        fullText = fallback;
        usedModel = "safe-fallback";
        res.write(`data: ${JSON.stringify({ content: fallback, success: false })}\n\n`);
      }

      // 8. Run Agents Post-processing (Quiz & UI Metadata)
      const finalResult = await AgentRunner.postProcess(context, {
        text: fullText,
        reply: fullText,
        sources: sources || [],
        model_used: usedModel,
        intent: intent,
        doubt: doubt,
        success: usedModel !== "safe-fallback",
        rag_enhanced: ragResult.enhanced || false,
        rag_debug: ragResult.debug || null,
        fallbackReason: fallbackReason
      });

      res.write(`data: ${JSON.stringify({ metadata: finalResult })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // --- Legacy JSON Path (Internal fallback or non-stream clients) ---
    let aiResponse = "";
    let modelUsed = "";
    let fallbackReasonLegacy = null;

    for (const model of candidateChain) {
      try {
        console.log(`[Zero-Failure] Attempting: ${model}`);
        const responseData = await callAIModel(apiKey, model, finalMessages);

        if (isValidAIResponse(responseData)) {
          aiResponse = responseData;
          modelUsed = model;
          failureTracker.delete(model);
          break;
        } else {
          if (!fallbackReasonLegacy) fallbackReasonLegacy = "EMPTY_OR_INVALID_RESPONSE";
          failureTracker.set(model, { expiry: Date.now() + COOLDOWN_MS, reason: fallbackReasonLegacy });
        }
      } catch (error) {
        if (!fallbackReasonLegacy) {
           if (error.name === "AbortError") fallbackReasonLegacy = "REQUEST_TIMEOUT";
           else if (error.message.includes("HTTP 401") || error.message.includes("HTTP 403")) fallbackReasonLegacy = "PROVIDER_AUTH_ERROR";
           else if (error.message.includes("HTTP 402")) fallbackReasonLegacy = "INSUFFICIENT_CREDITS";
           else if (error.message.includes("HTTP 429")) fallbackReasonLegacy = "RATE_LIMITED";
           else fallbackReasonLegacy = `PROVIDER_ERROR: ${error.message}`;
        }
        failureTracker.set(model, { expiry: Date.now() + COOLDOWN_MS, reason: fallbackReasonLegacy });
      }
    }

    if (!aiResponse) {
      aiResponse = getSafeFallbackReply(latestUserMessage, intent);
      modelUsed = "safe-fallback";
      if (!fallbackReasonLegacy) {
         fallbackReasonLegacy = candidateChain.length === 0 ? "ALL_MODELS_IN_COOLDOWN" : "UNKNOWN_AI_ERROR";
      }
    }

    const answerBody = String(aiResponse).trim();
    const finalResult = await AgentRunner.postProcess(context, {
      text: answerBody,
      reply: answerBody,
      sources: sources || [],
      model_used: modelUsed,
      intent: intent,
      doubt: doubt,
      success: modelUsed !== "safe-fallback",
      rag_enhanced: ragResult.enhanced || false,
      rag_debug: ragResult.debug || null,
      fallbackReason: fallbackReasonLegacy
    });

    return res.json(finalResult);

  } catch (error) {
    log.error({ err: error, responseTimeMs: Date.now() - start }, 'POST /api/chat error');
    return res.status(500).json({ error: "Internal server error." });
  }
});

function getSafeFallbackReply(query, intent) {
  const base = "I'm currently optimizing my specialized learning modules. In the meantime, here is a general overview:";

  if (intent === "CODING") {
    return `${base}\n\nTo help with your coding request, please ensure your syntax is correct. I am syncing my developer tools and will be able to provide deep code analysis in a moment. What specific language or error are you working with?`;
  }

  if (intent === "DIAGRAM") {
    return `${base}\n\nI am refreshing my visual engine to generate a clear diagram for you. Please try asking for the specific structure or flow again in a minute.`;
  }

  return `${base}\n\nI'm StudyMate AI, and I'm here to help you learn effectively. My high-performance engines are currently under heavy load, but I'm ready to discuss your topic. Could you please provide more context or rephrase your question?`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function selectModel(intent) {
  return MODELS[intent] || MODELS.GENERAL;
}

function buildModelCandidates(selectedModel) {
  const ordered = [selectedModel, ...MODEL_FALLBACKS];
  return [...new Set(ordered.filter(Boolean))];
}

function isValidAIResponse(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();

  // 1. Minimum length validation
  if (t.length < 20) return false;

  // 2. Refusal phrase detection
  const refusalPhrases = [
    "i am an ai model",
    "i cannot assist",
    "i am unable to",
    "my purpose is",
    "sorry, i don't know",
    "limit reached",
    "internal server error",
    "as an ai",
    "my programming",
    "contact support"
  ];
  const lower = t.toLowerCase();
  return !refusalPhrases.some(p => lower.includes(p));
}

/**
 * detectIntent(query)
 * Classifies the query intent to route to the optimal model.
 */
function detectIntent(query, mode) {
  const text = String(query || "").toLowerCase();

  if (isIdentityQueryMatch(text)) return "identity";

  if (DIAGRAM_QUERY_REGEX.test(text)) return "DIAGRAM";
  if (CODE_QUERY_REGEX.test(text) || mode === "coding") return "CODING";

  const explanationKeywords = ["explain", "how", "why", "what is", "define", "concept", "theory"];
  if (explanationKeywords.some(kw => text.includes(kw))) return "EXPLANATION";

  return "GENERAL";
}

function isIdentityQueryMatch(query) {
  const text = String(query || "").toLowerCase();
  const identityKeywords = [
    "who made", "who created", "who built", "who developed", "who coded",
    "who is the owner", "who is the creator", "your developer", "your owner",
    "who built this app", "anthropic", "openai", "google", "meta"
  ];
  return identityKeywords.some(kw => text.includes(kw));
}

function shouldSuggestQuiz(text, intent) {
  // Temporarily disabled to prevent legacy quiz CTA
  return false;
}

function buildAgentPrompt(message, intent, mode, currentQuestion, autoQuestionEnabled = true, kbExactMatch = false) {
  if (intent === "quiz") {
    return currentQuestion ? PROMPT_TEMPLATES.QUIZ_EVAL : PROMPT_TEMPLATES.QUIZ_GEN;
  }

  let chatPrompt = PROMPT_TEMPLATES.CHAT;
  const lowerMsg = String(message || "").toLowerCase();

  // Enforce code blocks for coding queries
  if (CODE_QUERY_REGEX.test(lowerMsg) || mode === "coding") {
    chatPrompt += "\n[CRITICAL: User is asking for code. You MUST provide a complete, working code block with proper syntax highlighting. Do NOT just give theory.]";
  }

  // KB Strict Rules (RULE 4)
  if (kbExactMatch) {
    chatPrompt += "\n[CRITICAL KNOWLEDGE BASE RULES: You have been provided with an official [VERIFIED STUDYMATE AI KNOWLEDGE BASE RESULT]. You MUST answer the user's question USING ONLY the provided Knowledge Base Answer. Never fabricate, guess, or infer company information. You may use friendly wording and markdown, but do not introduce new facts.]";
  }

  // Encourage Mermaid for diagrams
  if (DIAGRAM_QUERY_REGEX.test(lowerMsg)) {
    chatPrompt += "\n[CRITICAL: User is asking for a diagram. You MUST use Mermaid syntax ( \`\`\`mermaid ) to draw a clear visual structure.]";
  }

  if (!autoQuestionEnabled) {
    chatPrompt = chatPrompt.replace(/Follow-up: \(Ask exactly ONE natural, contextual, related question\. Do NOT mention quizzes\.\)/g, "");
    chatPrompt += "\n[Do NOT ask any follow-up questions.]";
  }
  return chatPrompt;
}


function getRandomIdentityResponse() {
  let index;
  do {
    index = Math.floor(Math.random() * IDENTITY_RESPONSES.length);
  } while (index === lastIdentityIndex && IDENTITY_RESPONSES.length > 1);
  lastIdentityIndex = index;
  return IDENTITY_RESPONSES[index];
}

function normalizeIdentityCacheKey(message) {
  return String(message || "").trim().toLowerCase();
}

function getCachedIdentityResult(message) {
  const key = normalizeIdentityCacheKey(message);
  if (!key) return null;
  const cachedItem = identityCache.get(key);
  if (!cachedItem) return null;
  if (Date.now() - cachedItem.timestamp > IDENTITY_CACHE_TTL_MS) {
    identityCache.delete(key);
    return null;
  }
  return cachedItem.value;
}

function setCachedIdentityResult(message, value) {
  const key = normalizeIdentityCacheKey(message);
  if (!key || typeof value !== "boolean") return;
  identityCache.set(key, { value, timestamp: Date.now() });
}

function quickIdentityCheck(message) {
  const text = String(message || "")
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) return false;

  const groups = [
    ["who", "made"],
    ["who", "created"],
    ["who", "built"],
    ["who", "developed"],
    ["your", "creator"],
    ["your", "developer"],
    ["your", "owner"],
    ["who", "is", "behind"],
    ["kisne", "banaya"],
    ["kaun", "hai", "developer"]
  ];

  return groups.some(group => group.every(word => text.includes(word)));
}

async function isIdentityQuery(apiKey, userMessage) {
  // Sanitize user input — prevent prompt injection (VULN-13)
  const sanitizedMessage = JSON.stringify(String(userMessage || "").slice(0, 1000));
  const prompt = `You are an intent classifier.

Return ONLY "YES" or "NO".

Return "YES" if the user is asking about:
- who created you
- who built you
- who developed you
- who owns you
- your creator or developer

This includes:
- English
- Hindi
- Hinglish (mixed language)

Examples:
- who made you -> YES
- who is your developer -> YES
- tumhe kisne banaya -> YES
- tumhara developer kaun hai -> YES
- who is elon musk -> NO

Message:
${sanitizedMessage}
`;

  try {
    const classifierModel = (await modelRegistry.resolveModelForRole("fast_classifier"))?.provider_id || IDENTITY_CLASSIFIER_MODEL;
    const result = await fetchWithRetry(
      () => callAIModel(apiKey, classifierModel, [{ role: "user", content: prompt }]),
      1
    );
    return String(result).trim().toUpperCase().includes("YES");
  } catch (error) {
    console.error("Identity detection failed:", error.message);
    return false;
  }
}

async function handleIdentityQuery(apiKey, userMessage) {
  // 1. Robust normalized check first
  if (quickIdentityCheck(userMessage)) {
    return { text: getRandomIdentityResponse(), sources: [] };
  }

  // 2. Fallback to AI classifier for ambiguous cases
  const cached = getCachedIdentityResult(userMessage);
  if (cached === true) {
    return { text: getRandomIdentityResponse(), sources: [] };
  }
  if (cached === false) {
    return null;
  }

  const identityIntent = await isIdentityQuery(apiKey, userMessage);
  setCachedIdentityResult(userMessage, identityIntent);

  if (!identityIntent) return null;
  return { text: getRandomIdentityResponse(), sources: [] };
}

// fetchWithRetry removed (moved to primary helper section)

async function callAIModel(apiKey, model, messages) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // Strict 8s timeout

  // PRE-FLIGHT SAFETY CHECK (CRITICAL: 100% Free enforcement & Authoritative Registry)
  const isAuthorized = model === IDENTITY_CLASSIFIER_MODEL || await modelRegistry.isAuthorizedModel(model) || (MODEL_POOL.includes(model) && model.endsWith(":free"));
  if (!isAuthorized) {
    throw new Error(`CRITICAL BLOCKED: Model ${model} is not authorized in Model Registry or not free.`);
  }

  try {
    const requestBody = {
      model,
      messages,
      provider: {
        allow_fallbacks: false // Disable provider-level paid fallbacks
      }
    };

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://aadirishi.in/",
        "X-Title": "StudyMate AI"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      const rawError = await response.text();
      throw new Error(`OpenRouter HTTP ${response.status}: ${rawError}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) throw new Error("Empty response from provider.");

    return String(content);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Timeout: AI model took too long (>8s).");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Caching System
 */
function normalizeMessage(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function generateCacheKey({ message, intent, userProfile, mode }) {
  const msg = normalizeMessage(message);
  const grade = userProfile?.grade || "N/A";
  const style = userProfile?.preferred_style || "N/A";
  return `MSG:${msg}|INT:${intent}|MODE:${mode}|G:${grade}|S:${style}`;
}

function getCachedResponse(key) {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached.data;
}

function setCache(key, data) {
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  responseCache.set(key, {
    data,
    timestamp: Date.now()
  });
}

function extractQuiz(text) {
  if (!text) return null;
  const match = text.match(/Quiz:\s*(.*)/i);
  return match ? match[1].trim() : null;
}



function getRecentHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-5).map(msg => {
    let content = String(msg.content || "");
    if (content.length > 300) {
      content = content.substring(0, 300) + "...";
    }
    return {
      role: msg.role === "user" ? "user" : "assistant",
      content
    };
  });
}

function buildContextLayer({ userProfile, intent, doubt }) {
  const grade = userProfile?.grade || "Unknown";
  const goal = userProfile?.goal || "General Learning";
  const style = userProfile?.preferred_style || "Simple";

  return `
STUDENT CONTEXT:
- Level: ${grade}
- Goal: ${goal}
- Style: ${style}
- Intent: ${intent}
- Doubt Mode: ${doubt ? "ON" : "OFF"}

INSTRUCTION: Adapt to student level, align with goal, and follow preferred style.
`.trim();
}

/**
 * Prompt Builder
 */
function buildPrompt({ message, intent, userProfile, externalContext, doubt, mode }) {
  const contextLayer = buildContextLayer({ userProfile, intent, doubt });
  const doubtInstructions = doubt ? PROMPT_TEMPLATES.DOUBT.trim() : "";
  const modeInstructions = mode === "exam" ? PROMPT_TEMPLATES.EXAM.trim() : "";
  const base = (intent === "FAST" || mode === "coding") ? "" : PROMPT_TEMPLATES.BASE.trim();
  const specific = PROMPT_TEMPLATES[intent] || PROMPT_TEMPLATES.GENERAL;

  return `You are StudyMate AI, a smart and friendly tutor.

${THINKING_PROMPT.trim()}

${contextLayer}

${modeInstructions ? `MODE INSTRUCTIONS:\n${modeInstructions}\n\n` : ""}${doubtInstructions ? `IMPORTANT: ${doubtInstructions}\n\n` : ""}${base ? `${base}\n\n` : ""}Additional Context: ${externalContext || "No additional data."}

User Question:
${message}

Task: ${specific}

Final Rule: Always teach clearly and simply. Use step-by-step logic.`;
}

function getLatestUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && typeof messages[i]?.content === "string") {
      return messages[i].content;
    }
  }
  return "";
}

function isRealtimeQuery(userMessage) {
  return REALTIME_QUERY_REGEX.test(String(userMessage || ""));
}

function getCachedRealtimeContext(query) {
  const cacheKey = String(query || "").trim().toLowerCase();
  if (!cacheKey) return { text: "", sources: [] };
  const cachedItem = realtimeCache.get(cacheKey);
  if (!cachedItem) return { text: "", sources: [] };
  if (Date.now() - cachedItem.timestamp > REALTIME_CACHE_TTL_MS) {
    realtimeCache.delete(cacheKey);
    return { text: "", sources: [] };
  }
  return cachedItem.value;
}

function setCachedRealtimeContext(query, value) {
  const cacheKey = String(query || "").trim().toLowerCase();
  if (!cacheKey || !value?.text) return;
  realtimeCache.set(cacheKey, { value, timestamp: Date.now() });
}

async function fetchRealtimeContext(query) {
  const cached = getCachedRealtimeContext(query);
  if (cached.text) return cached;

  const [newsDataResult, ddgResult] = await Promise.allSettled([
    fetchNewsData(query),
    fetchSearchResults(query)
  ]);

  if (newsDataResult.status === "rejected") {
    console.error("[Realtime] NewsData failed:", newsDataResult.reason);
  }
  if (ddgResult.status === "rejected") {
    console.error("[Realtime] DuckDuckGo failed:", ddgResult.reason);
  }

  const newsSources = newsDataResult.status === "fulfilled" && Array.isArray(newsDataResult.value?.sources)
    ? newsDataResult.value.sources
    : [];
  const ddgSources = ddgResult.status === "fulfilled" && Array.isArray(ddgResult.value?.sources)
    ? ddgResult.value.sources
    : [];
  const combinedSources = dedupeSources([...newsSources, ...ddgSources]).slice(0, 5);
  const externalText = combinedSources.map((src) => `- ${src.title}`).join("\n");

  const context = {
    text: externalText,
    sources: combinedSources
  };
  if (context.text || context.sources.length > 0) {
    setCachedRealtimeContext(query, context);
  }
  return context;
}

async function fetchSearchResults(query) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`, {
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo request failed with status ${res.status}`);
    }

    const data = await res.json();
    const sources = collectDuckDuckGoSources(data?.RelatedTopics).slice(0, 5);
    const text = sources.map((source) => source.title).join("\n");

    return {
      text,
      sources
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function collectDuckDuckGoSources(relatedTopics) {
  if (!Array.isArray(relatedTopics)) return [];
  const flatItems = [];
  for (const item of relatedTopics) {
    if (item?.FirstURL && item?.Text) {
      flatItems.push(item);
      continue;
    }
    if (Array.isArray(item?.Topics)) {
      for (const nested of item.Topics) {
        if (nested?.FirstURL && nested?.Text) {
          flatItems.push(nested);
        }
      }
    }
  }
  return flatItems.map((item) => ({
    title: item.Text,
    url: item.FirstURL
  })).filter((item) => /^https?:\/\//i.test(item.url));
}

function dedupeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.filter((src, index, self) => (
    index === self.findIndex((s) => String(s?.url || "").trim() === String(src?.url || "").trim())
  ));
}

async function fetchNewsData(query) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) return { text: "", sources: [] };

    const url = `https://newsdata.io/api/1/news?apikey=${apiKey}&q=${encodeURIComponent(query)}&language=en`;
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`NewsData request failed with status ${res.status}`);
    }

    const data = await res.json();
    if (!Array.isArray(data?.results) || data.results.length === 0) {
      return { text: "", sources: [] };
    }

    const now = new Date();
    const freshArticles = data.results.filter((article) => {
      if (!article?.pubDate || !article?.link || !article?.title) return false;
      if (!/^https?:\/\//i.test(article.link)) return false;

      const published = new Date(article.pubDate);
      if (Number.isNaN(published.getTime())) return false;

      const diffHours = (now - published) / (1000 * 60 * 60);
      return diffHours >= 0 && diffHours <= 24;
    });

    if (freshArticles.length === 0) {
      return { text: "", sources: [] };
    }

    const articles = freshArticles.slice(0, 5);

    const sources = articles.map((article) => ({
      title: article.title,
      url: article.link
    }));
    const text = articles.map((article) => article.title).join("\n");

    return {
      text,
      sources
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const serverStartupStart = Date.now();
const server = app.listen(PORT, () => {
  const totalStartupTime = Date.now() - serverStartupStart;
  const firebaseStatus = require('./services/firebaseAdmin');
  
  log.info({ 
    port: PORT,
    startupTimeMs: totalStartupTime,
    firebaseInitMs: firebaseStatus.initDurationMs || 0
  }, `StudyMate AI Backend running on http://localhost:${PORT}`);
});

// Graceful Shutdown
function gracefulShutdown(signal) {
  log.info(`[Server] Received ${signal}. Shutting down gracefully...`);
  
  server.close(async () => {
    log.info('[Server] Closed out remaining connections.');
    
    try {
      const firebaseStatus = require('./services/firebaseAdmin');
      if (firebaseStatus.isInitialized && firebaseStatus.app) {
        await firebaseStatus.app.delete();
        log.info('[Firebase Admin] Resources released cleanly.');
      }
    } catch (e) {
      log.error({ err: e }, '[Firebase Admin] Error during cleanup.');
    }
    
    process.exit(0);
  });
  
  // Force close after 10s
  setTimeout(() => {
    log.error('[Server] Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
