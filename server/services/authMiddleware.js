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
    return res.status(401).json({ error: 'Authentication required. Please log in.', code: 'MISSING_TOKEN' });
  }

  const idToken = authHeader.split('Bearer ')[1].trim();
  if (!idToken || idToken.length < 20) {
    return res.status(401).json({ error: 'Invalid authentication token.', code: 'INVALID_TOKEN' });
  }

  try {
    if (!auth || typeof auth.verifyIdToken !== 'function') {
      log.error('Firebase Auth service is uninitialized');
      return res.status(500).json({ error: 'Internal Auth Service Unavailable', code: 'AUTH_UNAVAILABLE' });
    }

    const decodedToken = await auth.verifyIdToken(idToken);
    req.verifiedUserId = decodedToken.uid;
    req.verifiedEmail = decodedToken.email || '';
    req.verifiedDisplayName = decodedToken.name || '';
    req.isAdmin = decodedToken.admin === true || decodedToken.role === 'admin' || decodedToken.isAdmin === true;
    
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
    const isExpired = error.code === 'auth/id-token-expired';
    log.warn({ err: error.code || error.message }, 'Token verification failed');
    return res.status(401).json({ 
      error: isExpired ? 'Authentication token expired. Please refresh session.' : 'Invalid or expired authentication token.',
      code: error.code || 'INVALID_TOKEN'
    });
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
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token', code: 'MISSING_TOKEN' });
  }

  const idToken = authHeader.split('Bearer ')[1].trim();
  if (!idToken || idToken.length < 20) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token', code: 'INVALID_TOKEN' });
  }

  try {
    if (!auth || typeof auth.verifyIdToken !== 'function') {
      log.error('Firebase Auth service is uninitialized');
      return res.status(500).json({ error: 'Internal Auth Service Unavailable', code: 'AUTH_UNAVAILABLE' });
    }

    const decodedToken = await auth.verifyIdToken(idToken);
    
    const isAdmin = decodedToken.admin === true || decodedToken.role === 'admin' || decodedToken.isAdmin === true;
    if (!isAdmin) {
      log.warn({ uid: decodedToken.uid, email: decodedToken.email }, 'Non-admin attempted admin action');
      return res.status(403).json({ error: 'Forbidden: Requires admin privileges', code: 'FORBIDDEN_NOT_ADMIN' });
    }
    
    req.adminUser = decodedToken;
    req.verifiedUserId = decodedToken.uid;
    next();
  } catch (error) {
    const isExpired = error.code === 'auth/id-token-expired';
    log.warn({ err: error.code || error.message }, 'Admin verification failed');
    res.status(401).json({ 
      error: isExpired ? 'Unauthorized: Token expired' : 'Unauthorized: Invalid token',
      code: error.code || 'INVALID_TOKEN'
    });
  }
}

module.exports = { requireAuth, verifyAdmin };
