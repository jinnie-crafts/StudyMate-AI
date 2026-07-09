/**
 * Auth Middleware — StudyMate AI
 * 
 * Firebase ID token verification for API routes.
 * Derives authenticated UID from the verified token —
 * NEVER trusts userId from the request body.
 */

const { auth } = require('./firebaseAdmin');
const { loggers } = require('./logger');
const log = loggers.auth;

/**
 * Middleware: Verify Firebase ID token and set req.verifiedUserId.
 * For /api/chat: Required authentication. Returns 401 if no valid token.
 * 
 * Usage: app.post('/api/chat', requireAuth, handler)
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  if (!idToken || idToken.length < 20) {
    return res.status(401).json({ error: 'Invalid authentication token.' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.verifiedUserId = decodedToken.uid;
    req.verifiedEmail = decodedToken.email || '';
    req.verifiedDisplayName = decodedToken.name || '';
    req.isAdmin = decodedToken.admin === true;
    
    // CRITICAL: Override any userId in the body with the verified one
    if (req.body) {
      req.body.userId = decodedToken.uid;
      if (req.body.userContext) {
        req.body.userContext.email = decodedToken.email || req.body.userContext.email;
        req.body.userContext.name = decodedToken.name || req.body.userContext.name;
      }
    }
    
    next();
  } catch (error) {
    log.warn({ err: error.code }, 'Token verification failed');
    return res.status(401).json({ error: 'Invalid or expired authentication token.' });
  }
}

/**
 * Middleware: Verify Firebase ID token AND admin custom claim.
 * Returns 403 if user is not an admin.
 * 
 * Usage: router.post('/kb/entry', verifyAdmin, handler)
 */
async function verifyAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    
    if (decodedToken.admin !== true) {
      log.warn({ uid: decodedToken.uid }, 'Non-admin attempted admin action');
      return res.status(403).json({ error: 'Forbidden: Requires admin privileges' });
    }
    
    req.adminUser = decodedToken;
    req.verifiedUserId = decodedToken.uid;
    next();
  } catch (error) {
    log.warn({ err: error.code }, 'Admin verification failed');
    res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

module.exports = { requireAuth, verifyAdmin };
