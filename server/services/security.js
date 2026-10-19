const { db, FieldValue } = require('./firebaseAdmin');
const crypto = require('crypto');
const { evaluateSemanticThreat } = require('./semanticSecurity');
const config = require('../config/securityConfig');
const { loggers } = require('./logger');
const log = loggers.security;

// 1. Regex Categories & Threat Scores
const SECURITY_CATEGORIES = {
  PRIVILEGE_ESCALATION: { level: 'medium', score: 40, regex: /\b(make me admin|grant admin|give me admin|remove restrictions|grant premium)\b/i },
  DATABASE_MODIFICATION: { level: 'high', score: 70, regex: /\b(delete database|drop database|modify firestore|update database|reset database)\b/i },
  AUTH_MODIFICATION: { level: 'high', score: 80, regex: /\b(disable email verification|disable authentication)\b/i },
  CONFIG_CHANGE: { level: 'high', score: 60, regex: /\b(change owner|change developer|change app name|change branding|update api keys|change api key)\b/i },
  SECURITY_RULE_MODIFICATION: { level: 'high', score: 80, regex: /\b(change security rules|update security rules)\b/i },
  SYSTEM_PROMPT_DISCOVERY: { level: 'low', score: 15, regex: /\b(reveal system prompt|ignore previous instructions|what are your instructions)\b/i },
  BULK_DATA_OPERATION: { level: 'critical', score: 120, regex: /\b(delete all|delete all users|export all users|download all data)\b/i },
  API_KEY_REQUESTS: { level: 'critical', score: 100, regex: /\b(show api key|get api key|reveal tokens|env variables)\b/i },
  PROMPT_INJECTION: { level: 'low', score: 10, regex: /\b(forget all instructions|you are now|system override)\b/i },
  ROLE_MODIFICATION: { level: 'medium', score: 40, regex: /\b(promote my account|update my role)\b/i }
};

const REFUSAL_MESSAGE = "I can't perform administrative or system-level operations through chat. If you're an authorized administrator, please use the Admin Panel or backend management tools.";
const RATE_LIMIT_MESSAGE = "⚠️ SECURITY ALERT: You have exceeded the allowed threshold for privileged requests. Your AI access is temporarily rate-limited. Please stop attempting administrative commands.";
const SUSPEND_MESSAGE = "🚫 ACCOUNT SUSPENDED: Your AI chat access has been temporarily suspended due to repeated critical security violations. An administrator has been notified.";
const WARNING_MESSAGE = "⚠️ WARNING: You are attempting to perform a privileged or administrative action. Repeated attempts will result in account suspension.";

// Internal Metrics
const metrics = {
  regexMatchCount: 0,
  heuristicMatchCount: 0,
  semanticCallCount: 0,
  semanticMatchCount: 0
};

// Heuristics: Look for suspicious word combinations
function heuristicCheck(text) {
  const adminKeywords = ['admin', 'owner', 'database', 'permission', 'role', 'api key', 'secret', 'token'];
  const actionVerbs = ['make', 'give', 'grant', 'promote', 'change', 'update', 'delete', 'remove', 'show', 'reveal', 'bypass'];
  
  let adminCount = adminKeywords.filter(k => text.includes(k)).length;
  let actionCount = actionVerbs.filter(v => text.includes(v)).length;
  
  return (adminCount >= 1 && actionCount >= 1);
}

// Calculate dynamic rolling score from active events
async function getRollingThreatScore(userId) {
  if (!userId || userId === 'anonymous' || !db) return 0;
  
  const windowStart = new Date();
  windowStart.setHours(windowStart.getHours() - config.THREAT_WINDOW_HOURS);
  
  try {
    const logsRef = db.collection('security_logs');
    const q = logsRef.where('userId', '==', userId)
                     .where('timestamp', '>=', windowStart)
                     .orderBy('timestamp', 'desc');
    const snapshot = await q.get();
    
    let totalScore = 0;
    let stopAggregation = false;

    snapshot.forEach(doc => {
      if (stopAggregation) return;
      const data = doc.data();
      if (data.eventType === 'admin_reset') {
        stopAggregation = true; // Stop aggregating past the reset event
      } else {
        totalScore += (data.threatScore || 0);
      }
    });
    
    return totalScore;
  } catch (err) {
    log.error({ err, userId }, 'Failed to fetch rolling threat score');
    return 0; // Fail open for score retrieval (not for blocking decisions)
  }
}

// Check Deduplication
async function deduplicateLog(userId, prompt) {
  if (!userId || userId === 'anonymous') return null;
  
  const oneHourAgo = new Date();
  oneHourAgo.setHours(oneHourAgo.getHours() - 1);
  
  try {
    const logsRef = db.collection('security_logs');
    const q = logsRef.where('userId', '==', userId)
                     .where('prompt', '==', prompt)
                     .orderBy('timestamp', 'desc')
                     .limit(1);
    const snapshot = await q.get();
    
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const data = doc.data();
      const docTime = data.timestamp ? data.timestamp.toDate() : new Date();
      
      // Do not deduplicate across an admin reset
      if (docTime >= oneHourAgo && data.eventType !== 'admin_reset') {
        return { id: doc.id, data };
      }
    }
  } catch (err) {
    log.error({ err, userId }, 'Failed deduplication check');
  }
  return null;
}

function determineThreatLevel(score, suspendEnabled) {
  if (score >= config.THREAT_SUSPEND_SCORE && suspendEnabled) return 'critical';
  if (score >= config.THREAT_RATE_LIMIT_SCORE) return 'high';
  if (score >= config.THREAT_WARNING_SCORE) return 'medium';
  return 'low';
}

function getRefusalMessage(score, suspendEnabled) {
  if (score >= config.THREAT_SUSPEND_SCORE && suspendEnabled) return SUSPEND_MESSAGE;
  if (score >= config.THREAT_RATE_LIMIT_SCORE) return RATE_LIMIT_MESSAGE;
  if (score >= config.THREAT_WARNING_SCORE) return WARNING_MESSAGE;
  return REFUSAL_MESSAGE;
}

async function checkSecurity(req, message) {
  const tStart = performance.now();
  if (!config.SECURITY_LOGGING_ENABLED) return { blocked: false };

  const { userId = 'anonymous', userContext = {} } = req.body || {};
  const sessionId = req.headers['x-session-id'] || crypto.randomUUID();
  const requestId = crypto.randomUUID();

  // Evaluate current user standing BEFORE processing the prompt
  // Users who are already suspended stay suspended until reset or decay.
  const currentRollingScore = await getRollingThreatScore(userId);
  if (currentRollingScore >= config.THREAT_SUSPEND_SCORE) {
    return { blocked: true, refusal: SUSPEND_MESSAGE };
  }
  if (currentRollingScore >= config.THREAT_RATE_LIMIT_SCORE) {
    return { blocked: true, refusal: RATE_LIMIT_MESSAGE };
  }

  if (!message || typeof message !== 'string') return { blocked: false };
  const text = message.toLowerCase();

  let detectedCategory = null;
  let threatScore = 0;
  let severity = 'low';
  let blockedBy = [];
  
  // Layer 1: Regex
  const tRegexStart = performance.now();
  for (const [category, rule] of Object.entries(SECURITY_CATEGORIES)) {
    if (rule.regex.test(text)) {
      detectedCategory = category;
      threatScore = rule.score;
      severity = rule.level;
      blockedBy.push('Regex');
      metrics.regexMatchCount++;
      break;
    }
  }
  const tRegexTime = performance.now() - tRegexStart;
  
  // Layer 2: Heuristics
  const tHeuristicStart = performance.now();
  const isHeuristicMatch = heuristicCheck(text);
  if (isHeuristicMatch) {
    blockedBy.push('Heuristic');
    metrics.heuristicMatchCount++;
  }
  const tHeuristicTime = performance.now() - tHeuristicStart;

  // Layer 3: Semantic LLM — ONLY for ambiguous/suspicious prompts (user requirement)
  // Do NOT execute an LLM call for every normal request.
  let tSemanticTime = 0;
  const isAmbiguousOrSuspicious = detectedCategory || isHeuristicMatch;
  
  if (config.SEMANTIC_SECURITY_ENABLED && isAmbiguousOrSuspicious) {
    metrics.semanticCallCount++;
    const tSemanticStart = performance.now();
    try {
      // Pass isSuspicious=true so semantic evaluator fails closed on error
      const semanticResult = await evaluateSemanticThreat(message, true);
      if (semanticResult && semanticResult.isMalicious) {
        if (!detectedCategory) {
          detectedCategory = semanticResult.category || 'SEMANTIC_DETECTION';
          threatScore = semanticResult.score || 50;
          severity = semanticResult.level || 'medium';
        }
        blockedBy.push('SemanticLLM');
        metrics.semanticMatchCount++;
      }
    } catch (err) {
      log.error({ err }, 'Semantic Security Check failed');
      // Fail closed: if semantic fails on a suspicious prompt, treat as confirmed
      if (!detectedCategory && isHeuristicMatch) {
        detectedCategory = 'SEMANTIC_FAILURE_FALLBACK';
        threatScore = 50;
        severity = 'medium';
        blockedBy.push('SemanticFailClosed');
      }
    }
    tSemanticTime = performance.now() - tSemanticStart;
  }
  
  if (detectedCategory) {
    // False Positive Protection Check
    const newRollingScore = currentRollingScore + threatScore;
    const isSuspensionDeferred = (newRollingScore >= config.THREAT_SUSPEND_SCORE) && (blockedBy.length < 2);
    
    // If deferred, cap the actual enforcement level, but retain true score for logs
    const threatLevel = determineThreatLevel(newRollingScore, !isSuspensionDeferred);
    const refusal = getRefusalMessage(newRollingScore, !isSuspensionDeferred);
    
    const tLogStart = performance.now();
    const dup = await deduplicateLog(userId, message);
    
    try {
      if (dup) {
        // Increment
        await db.collection('security_logs').doc(dup.id).update({
          attemptCount: FieldValue.increment(1),
          timestamp: FieldValue.serverTimestamp(),
          rollingThreatScore: newRollingScore,
          threatLevel: threatLevel
        });
      } else {
        // New log
        const logEntry = {
          eventId: crypto.randomUUID(),
          requestId,
          sessionId,
          eventType: "unauthorized_admin_request",
          severity,
          threatScore,
          rollingThreatScore: newRollingScore,
          threatLevel,
          userId,
          email: userContext.email || '',
          displayName: userContext.name || '',
          provider: userContext.provider || '',
          ipAddress: req.ip || req.headers['x-forwarded-for'] || '',
          userAgent: req.headers['user-agent'] || '',
          prompt: message,
          detectedIntent: detectedCategory,
          actionTaken: "blocked",
          blockedBy: blockedBy.join(', '),
          attemptCount: 1,
          model: req.body.userProfile?.model_choice || 'auto',
          backendVersion: "1.2",
          platform: "web",
          timestamp: FieldValue.serverTimestamp(),
          suspensionDeferred: isSuspensionDeferred
        };
        await db.collection('security_logs').add(logEntry);
      }
      const tLogTime = performance.now() - tLogStart;
      const tTotal = performance.now() - tStart;
      
      log.info({
        pipeline: `${tTotal.toFixed(1)}ms`,
        regex: `${tRegexTime.toFixed(1)}ms`,
        heuristic: `${tHeuristicTime.toFixed(1)}ms`,
        semantic: `${tSemanticTime.toFixed(1)}ms`,
        logWrite: `${tLogTime.toFixed(1)}ms`
      }, 'Security pipeline metrics');
      log.warn({
        blockedBy: blockedBy.join('+'),
        userId,
        category: detectedCategory,
        rollingScore: newRollingScore,
        deferred: isSuspensionDeferred
      }, 'Security event blocked');
      
    } catch (err) {
      log.error({ err }, 'Failed to write to security_logs');
    }
    
    return { blocked: true, refusal };
  }
  
  return { blocked: false };
}

module.exports = { checkSecurity, REFUSAL_MESSAGE };
