/**
 * Structured Logger — StudyMate AI
 * 
 * Production-grade logging with pino.
 * - Structured JSON in production
 * - Pretty-printed in development
 * - Sensitive field redaction
 * - Named child loggers for each component
 */

const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

// Fields to redact from all log output
const REDACT_PATHS = [
  'apiKey',
  'privateKey',
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'OPENROUTER_API_KEY',
  'FIREBASE_PRIVATE_KEY',
  'req.headers.authorization',
  'req.headers.cookie'
];

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]'
  },
  ...(isProduction
    ? {
        // Production: structured JSON for log aggregation
        formatters: {
          level(label) { return { level: label }; }
        },
        timestamp: pino.stdTimeFunctions.isoTime
      }
    : {
        // Development: human-readable output
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname'
          }
        }
      }
  )
});

// Named child loggers for each subsystem
const loggers = {
  server: logger.child({ component: 'server' }),
  security: logger.child({ component: 'security' }),
  auth: logger.child({ component: 'auth' }),
  rag: logger.child({ component: 'rag' }),
  memory: logger.child({ component: 'memory' }),
  kb: logger.child({ component: 'kb' }),
  firebase: logger.child({ component: 'firebase' }),
  admin: logger.child({ component: 'admin' })
};

module.exports = { logger, loggers };
