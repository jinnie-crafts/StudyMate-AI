require('dotenv').config();

module.exports = {
  THREAT_WINDOW_HOURS: parseInt(process.env.THREAT_WINDOW_HOURS || "24", 10),
  THREAT_WARNING_SCORE: parseInt(process.env.THREAT_WARNING_SCORE || "50", 10),
  THREAT_RATE_LIMIT_SCORE: parseInt(process.env.THREAT_RATE_LIMIT_SCORE || "100", 10),
  THREAT_SUSPEND_SCORE: parseInt(process.env.THREAT_SUSPEND_SCORE || "200", 10),
  RATE_LIMIT_DURATION_MS: 15 * 60 * 1000, // 15 mins
  SUSPENSION_DURATION_MS: 24 * 60 * 60 * 1000, // 24 hours
  SEMANTIC_SECURITY_ENABLED: process.env.SEMANTIC_SECURITY_ENABLED !== 'false',
  SECURITY_LOGGING_ENABLED: process.env.ENABLE_SECURITY_LOGGING !== 'false'
};
