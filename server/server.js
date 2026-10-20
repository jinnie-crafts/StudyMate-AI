/**
 * StudyMate AI — Backend Proxy
 *
 * Keeps the OpenRouter API key server-side.
 * Frontend calls POST /api/chat → this server → OpenRouter → response back.
 */

const fs = require("fs");
const path = require("path");

// Robust environment variable loading across execution paths (cwd, server/, root)
const envLocations = [
  path.join(__dirname, ".env"),
  path.join(process.cwd(), "server", ".env"),
  path.join(process.cwd(), ".env")
];
for (const envPath of envLocations) {
  if (fs.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
  }
}
require("dotenv").config(); // fallback to standard dotenv resolution

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
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
const aiService = require("./services/aiService"); // Centralized AI Request Pipeline Service

// Initialize AI Service singleton at startup
aiService.initialize();

const REALTIME_QUERY_REGEX = /(today|now|latest|news|current|recent|weather|price|score|stock|time)/i;
const NEWS_QUERY_REGEX = /(news|headlines|breaking|latest news|current affairs)/i;
const CODE_QUERY_REGEX = /code|program|example|debug|script|function|snippet|coding/i;
const MATH_QUERY_REGEX = /math|calculate|solve|equation/i;
const DIAGRAM_QUERY_REGEX = /diagram|chart|graph|flow|flowchart|structure|architecture/i;

// Dynamic model constants backed by the authoritative Model Registry (backwards-compatibility)
const DEFAULT_MODEL = "google/gemma-4-31b-it:free";
const IDENTITY_CLASSIFIER_MODEL = "apodex/apodex-1.1-mini:free";

const MODEL_POOL = new Proxy([], {
  get: (_target, prop) => {
    if (prop === 'includes') {
      return (val) => {
        for (const m of modelRegistry.inMemoryRegistry.values()) {
          if (m.provider_id === val && m.enabled) return true;
        }
        return false;
      };
    }
    const arr = Array.from(modelRegistry.inMemoryRegistry.values())
      .filter(m => m.enabled)
      .map(m => m.provider_id);
    return arr[prop];
  }
});

const MODELS = new Proxy({}, {
  get: (_target, prop) => {
    const roleMap = {
      CODING: "coding_assistant",
      REASONING: "general_chat",
      FAST: "apodex_mini",
      FALLBACK: "fallback_model",
      LONG_EXPLANATION: "general_chat",
      GENERAL: "general_chat"
    };
    const role = roleMap[prop] || "general_chat";
    const model = modelRegistry.inMemoryRegistry?.get(
      role === "fallback" ? "fallback_model" : (role === "fast_classifier" ? "apodex_mini" : (role === "exam_revision" ? "general_chat" : role))
    );
    return model?.provider_id || "google/gemma-4-31b-it:free";
  }
});

const failureTracker = aiService.failureTracker;
const COOLDOWN_MS = 5 * 60 * 1000;
let lastProbeTime = 0;
const PROBE_INTERVAL_MS = 10000;

let lastIdentityIndex = -1;
const IDENTITY_RESPONSES = [
  "StudyMate AI is developed by Rishu Maurya.",
  "This application is created by Rishu Maurya.",
  "Rishu Maurya is the developer of StudyMate AI.",
  "StudyMate AI is built by Rishu Maurya."
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

const corsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server / same-origin requests (no origin) and allowed origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false); // Reject unauthorized origins cleanly without throwing server error
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Origin'],
  credentials: false,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

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

// 3. Security Headers — Helmet (VULN-07) & Content Security Policy
const CSP_HEADER_VALUE = "default-src 'self'; script-src 'self' https://www.gstatic.com https://cdn.jsdelivr.net https://apis.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data: https://lh3.googleusercontent.com https://ui-avatars.com; connect-src 'self' http://localhost:3001 http://127.0.0.1:3001 http://localhost:3000 http://127.0.0.1:3000 http://localhost:5000 http://127.0.0.1:5000 http://localhost:5500 http://127.0.0.1:5500 https://api.aadirishi.in https://openrouter.ai https://*.firebaseio.com https://*.googleapis.com https://*.gstatic.com https://www.gstatic.com https://*.cloudfunctions.net; frame-src 'self' https://studymate-ai-bc65e.firebaseapp.com https://*.firebaseapp.com https://accounts.google.com; object-src 'none';";

app.use(helmet({
  contentSecurityPolicy: false,       // Custom CSP middleware applied below
  crossOriginEmbedderPolicy: false,   // Allow external resources
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP_HEADER_VALUE);
  next();
});

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
  'spaNavigation.js', 'modelRegistryClient.js', 'adminModelRegistry.js', 'adminAuthHelper.js', 'legal.js',
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

const MODEL_TIMEOUT_MS = 25000;

app.post("/api/chat", chatLimiter, requireAuth, async (req, res) => {
  const start = Date.now();
  try {
    const configCheck = aiService.validateConfig();
    const apiKey = aiService.apiKey || process.env.OPENROUTER_API_KEY;
    if (!configCheck.valid || !apiKey) {
      log.fatal("OPENROUTER_API_KEY is missing from environment.");
      return res.status(500).json({
        error: "AI Service is not configured. OPENROUTER_API_KEY is missing from server environment. Please set OPENROUTER_API_KEY in server/.env or Render Dashboard.",
        code: "CONFIG_ERROR",
        missingVariable: "OPENROUTER_API_KEY"
      });
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

    const userModelChoice = req.body.model_choice || req.body.model || req.body.userProfile?.model_choice || null;
    const reqId = Math.random().toString(36).substring(2, 9);
    log.info({ reqId, userId, role: modelRole, mode: normalizedMode, userModelChoice }, `[REQ-${reqId}] AI request received`);

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

    // Add session history context (last 5 messages) with standard role mapping
    const historyContext = messages.slice(-6, -1); // Exclude the latest user message which we add below
    historyContext.forEach(msg => {
      const msgRole = String(msg.role || '').toLowerCase();
      const standardRole = (msgRole === 'user') ? 'user' : 'assistant';
      finalMessages.push({ role: standardRole, content: String(msg.content || '') });
    });

    // If evaluating, include the question being answered
    if (intent === "quiz" && currentQuestion) {
      finalMessages.push({ role: "assistant", content: `Q: ${currentQuestion}` });
    }

    finalMessages.push({ role: "user", content: latestUserMessage });

    // 7. Support Streaming if requested
    if (req.body.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no" // Disable buffering for Nginx
      });
      res.flushHeaders();
      if (typeof res.flush === "function") res.flush();

      let streamResult;
      try {
        streamResult = await aiService.executeChatStream({
          role: modelRole,
          userChoice: userModelChoice,
          messages: finalMessages,
          reqId,
          timeoutMs: MODEL_TIMEOUT_MS,
          onChunk: (content) => {
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        });
      } catch (streamErr) {
        log.error({ reqId, err: streamErr.message }, `[REQ-${reqId}] Fatal stream execution error`);
        res.write(`data: ${JSON.stringify({ error: streamErr.message })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      let fullText = streamResult.fullText;
      let usedModel = streamResult.usedModel;
      let fallbackReason = streamResult.fallbackReason;

      if (!streamResult.success) {
        log.warn({ reqId, fallbackReason }, `[REQ-${reqId}] Candidate chain exhausted. Providing safe fallback.`);
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
        success: streamResult.success,
        rag_enhanced: ragResult.enhanced || false,
        rag_debug: ragResult.debug || null,
        fallbackReason: fallbackReason
      });

      res.write(`data: ${JSON.stringify({ metadata: finalResult })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // --- Legacy JSON Path (Internal fallback or non-stream clients) ---
    let jsonResult;
    try {
      jsonResult = await aiService.executeChatCompletion({
        role: modelRole,
        userChoice: userModelChoice,
        messages: finalMessages,
        reqId,
        timeoutMs: 15000
      });
    } catch (jsonErr) {
      log.error({ reqId, err: jsonErr.message }, `[REQ-${reqId}] JSON execution error`);
      return res.status(500).json({ error: jsonErr.message || "AI Service unavailable." });
    }

    let aiResponse = jsonResult.content;
    let modelUsed = jsonResult.modelUsed;
    let fallbackReasonLegacy = jsonResult.fallbackReason;

    if (!jsonResult.success || !aiResponse) {
      aiResponse = getSafeFallbackReply(latestUserMessage, intent);
      modelUsed = "safe-fallback";
    }

    const answerBody = String(aiResponse).trim();
    const finalResult = await AgentRunner.postProcess(context, {
      text: answerBody,
      reply: answerBody,
      sources: sources || [],
      model_used: modelUsed,
      intent: intent,
      doubt: doubt,
      success: jsonResult.success,
      rag_enhanced: ragResult.enhanced || false,
      rag_debug: ragResult.debug || null,
      fallbackReason: fallbackReasonLegacy
    });

    log.info({ reqId, modelUsed, durationMs: Date.now() - start }, `[REQ-${reqId}] Chat request completed`);
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

function selectModel(intent, mode = "general") {
  const roleMap = {
    CODING: "coding_assistant",
    EXAM: "exam_revision",
    FAST: "fast_classifier",
    FALLBACK: "fallback"
  };
  const role = (mode === "coding" || intent === "CODING") ? "coding_assistant" : (roleMap[intent] || "general_chat");
  const model = modelRegistry.inMemoryRegistry?.get(
    role === "fallback" ? "fallback_model" : (role === "fast_classifier" ? "apodex_mini" : (role === "exam_revision" ? "general_chat" : role))
  );
  return model?.provider_id || "google/gemma-4-31b-it:free";
}

function buildModelCandidates(selectedModel, role = "general_chat") {
  const fallbacks = Array.from(modelRegistry.inMemoryRegistry.values())
    .filter(m => Array.isArray(m.roles) && m.roles.includes("fallback") && m.enabled)
    .sort((a, b) => (a.fallback_priority || 99) - (b.fallback_priority || 99))
    .map(m => m.provider_id);
  const ordered = [selectedModel, ...fallbacks];
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
    const result = await aiService.executeDirectCompletion({
      role: "fast_classifier",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      maxTokens: 5
    });
    return String(result.content).trim().toUpperCase().includes("YES");
  } catch (error) {
    log.warn({ err: error.message }, "Identity detection fallback");
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
  const isAuthorized = await modelRegistry.isAuthorizedModel(model);
  if (!isAuthorized) {
    throw new Error(`CRITICAL BLOCKED: Model ${model} is not authorized in Model Registry or not enabled.`);
  }

  const result = await aiService.executeDirectCompletion({
    providerId: model,
    messages,
    timeoutMs: 8000
  });

  if (!result.content) throw new Error("Empty response from provider.");
  return String(result.content);
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

let server = null;
if (require.main === module) {
  const serverStartupStart = Date.now();
  server = app.listen(PORT, () => {
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
    
    if (server) {
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
    } else {
      process.exit(0);
    }
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

module.exports = { app, server };
