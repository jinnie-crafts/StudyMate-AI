require('dotenv').config();
const { loggers } = require('../services/logger');
const log = loggers.server;

const isProduction = process.env.NODE_ENV === 'production';

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

const DEFAULT_PRODUCTION_ORIGINS = [
  'https://aadirishi.in',
  'https://www.aadirishi.in',
  'https://studymate-ai-bc65e.web.app',
  'https://studymate-ai-bc65e.firebaseapp.com'
];

function validateAndNormalizeOrigins() {
  const rawOrigins = process.env.ALLOWED_ORIGINS;
  let originsToProcess = [];

  if (rawOrigins) {
    originsToProcess = rawOrigins.split(',').map(o => o.trim()).filter(Boolean);
  } else if (!isProduction) {
    originsToProcess = DEFAULT_DEV_ORIGINS;
    log.info('CORS fallback list loaded for development.');
  } else {
    originsToProcess = DEFAULT_PRODUCTION_ORIGINS;
    log.warn('ALLOWED_ORIGINS environment variable not set; loaded authoritative production defaults.');
  }

  const validOrigins = [];
  const seen = new Set();

  for (const origin of originsToProcess) {
    // Normalization: Trim and normalize trailing slash
    const normalized = origin.replace(/\/$/, '');

    // Validation: Reject malformed URLs
    try {
      const url = new URL(normalized);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        log.warn({ origin }, 'Rejected malformed origin URL: protocol must be http or https');
        continue;
      }
      if (url.pathname !== '/' && url.pathname !== '') {
        log.warn({ origin }, 'Rejected malformed origin URL: must not contain paths');
        continue;
      }
      if (url.search || url.hash) {
        log.warn({ origin }, 'Rejected malformed origin URL: must not contain query parameters or fragments');
        continue;
      }

      if (seen.has(normalized)) {
        log.warn({ origin: normalized }, 'Duplicate allowed origin detected and skipped');
      } else {
        seen.add(normalized);
        validOrigins.push(normalized);
      }
    } catch (err) {
      log.warn({ origin, error: err.message }, 'Rejected malformed origin URL: invalid format');
    }
  }

  if (isProduction && validOrigins.length === 0) {
    log.fatal('FATAL: Startup failed. Running in production mode but no valid trusted origins are configured in ALLOWED_ORIGINS.');
    process.exit(1);
  }

  return validOrigins;
}

const allowedOrigins = validateAndNormalizeOrigins();

// Structured Startup Logging
log.info({
  environment: process.env.NODE_ENV || 'development',
  allowedOrigins,
  port: process.env.PORT || 3001,
  corsStatus: allowedOrigins.length > 0 ? 'ACTIVE' : 'BLOCKED_ALL'
}, 'CORS Configuration Loaded');

module.exports = {
  allowedOrigins
};
