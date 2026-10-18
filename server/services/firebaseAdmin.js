const admin = require('firebase-admin');
const { cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');

try {
  require('dotenv').config();
} catch (e) {
  // Ignore missing dotenv in environments where it isn't needed or installed
}

// Helper to determine project ID
function getProjectId() {
  return process.env.FIREBASE_PROJECT_ID || "";
}

const initStartTime = Date.now();
let app;
let activeCredentialSource = 'None';
let isInitialized = false;
let initDurationMs = 0;

try {
  const getApps = admin.apps || (admin.app ? [admin.app()] : []);
  
  if (!Array.isArray(getApps) || getApps.length === 0) {
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;
    const projectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
    const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
    const privateKeyRaw = (process.env.FIREBASE_PRIVATE_KEY || "").trim();
    
    let initStrategy = 'None';
    let initStatus = 'FAILED';
    let missingVars = [];
    let failReason = '';

    // Check for local file in production
    const path = require('path');
    const fs = require('fs');
    const serverKeyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
    const rootKeyPath = path.join(__dirname, '..', '..', 'serviceAccountKey.json');
    const localFileExists = fs.existsSync(serverKeyPath) || fs.existsSync(rootKeyPath);

    if (isProduction && localFileExists) {
      console.warn('⚠️ [Firebase Admin] Warning: Local serviceAccountKey.json detected but ignored because the application is running in production.');
    }

    // Validate Environment Variables
    let hasEnvVars = false;
    if (projectId || clientEmail || privateKeyRaw) {
      if (!projectId) {
        missingVars.push('FIREBASE_PROJECT_ID (missing or empty)');
      }
      if (!clientEmail || !clientEmail.endsWith('.iam.gserviceaccount.com') || !/^\S+@\S+\.\S+$/.test(clientEmail)) {
        missingVars.push('FIREBASE_CLIENT_EMAIL (missing or invalid format)');
      }
      if (!privateKeyRaw || !privateKeyRaw.includes('-----BEGIN PRIVATE KEY-----') || !privateKeyRaw.includes('-----END PRIVATE KEY-----')) {
        missingVars.push('FIREBASE_PRIVATE_KEY (missing or malformed PEM)');
      }
      
      if (missingVars.length === 0) {
        hasEnvVars = true;
      } else {
        failReason = 'Environment variables validation failed.';
      }
    }

    if (hasEnvVars) {
      initStrategy = 'Environment Variables';
      try {
        const formattedPrivateKey = privateKeyRaw.replace(/\\n/g, '\n');
        const credential = cert({
          projectId,
          clientEmail,
          privateKey: formattedPrivateKey
        });
        app = admin.initializeApp({ credential, projectId });
        initStatus = 'SUCCESS';
        activeCredentialSource = initStrategy;
      } catch (e) {
        failReason = 'Failed to parse environment variables: ' + e.message;
      }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initStrategy = 'GOOGLE_APPLICATION_CREDENTIALS';
      try {
        app = admin.initializeApp();
        initStatus = 'SUCCESS';
        activeCredentialSource = initStrategy;
      } catch (e) {
        failReason = 'Failed using GOOGLE_APPLICATION_CREDENTIALS: ' + e.message;
      }
    } else if (process.env.FIREBASE_CONFIG) {
      initStrategy = 'FIREBASE_CONFIG';
      try {
        app = admin.initializeApp();
        initStatus = 'SUCCESS';
        activeCredentialSource = initStrategy;
      } catch (e) {
        failReason = 'Failed using FIREBASE_CONFIG: ' + e.message;
      }
    } else if (!isProduction) {
      initStrategy = 'Local serviceAccountKey.json';
      
      let localKeyPath = null;
      if (fs.existsSync(serverKeyPath)) {
        localKeyPath = serverKeyPath;
      } else if (fs.existsSync(rootKeyPath)) {
        localKeyPath = rootKeyPath;
      }

      if (localKeyPath) {
        try {
          const serviceAccount = require(localKeyPath);
          app = admin.initializeApp({ credential: cert(serviceAccount) });
          initStatus = 'SUCCESS';
          activeCredentialSource = initStrategy;
        } catch (e) {
          failReason = 'Error reading or parsing serviceAccountKey.json: ' + e.message;
        }
      } else {
        // Fallback: Initialize with Project ID for token verification and auth services
        const fallbackProjectId = projectId || 'studymate-ai-bc65e';
        try {
          app = admin.initializeApp({ projectId: fallbackProjectId });
          initStatus = 'SUCCESS';
          activeCredentialSource = 'Project ID Token Verifier';
          console.log(`ℹ️ [Firebase Admin] Initialized with Project ID (${fallbackProjectId}) for token verification`);
        } catch (e) {
          failReason = 'Failed initializing fallback project app: ' + e.message;
        }
      }
    } else {
      initStrategy = 'None (Production strict mode)';
      if (!failReason) failReason = 'No valid credentials found. Local file fallback is disabled in production.';
    }

    if (initStatus !== 'SUCCESS') {
      if (!projectId && !missingVars.includes('FIREBASE_PROJECT_ID (missing or empty)')) missingVars.push('FIREBASE_PROJECT_ID');
      if (!clientEmail && !missingVars.some(v => v.includes('FIREBASE_CLIENT_EMAIL'))) missingVars.push('FIREBASE_CLIENT_EMAIL');
      if (!privateKeyRaw && !missingVars.some(v => v.includes('FIREBASE_PRIVATE_KEY'))) missingVars.push('FIREBASE_PRIVATE_KEY');
      
      console.error(`
❌ [Firebase Admin] Initialization Error:
Environment: ${isProduction ? 'Production' : 'Development'}
Credential Source Attempted: ${initStrategy}
Status: FAILED
Firebase Project ID: ${projectId || 'Unknown'}
Reason for Failure: ${failReason || 'Credentials missing or invalid'}
Detected Missing Variables: ${missingVars.length ? '\n- ' + missingVars.join('\n- ') : 'None'}`);

      if (!isProduction) {
        console.error(`
🛠️  Recommended Actions:
1. Configure Environment Variables (.env file):
   FIREBASE_PROJECT_ID=your_project_id
   FIREBASE_CLIENT_EMAIL=your_client_email
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----\\n"

2. Configure GOOGLE_APPLICATION_CREDENTIALS:
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/serviceAccountKey.json"

3. Add local serviceAccountKey.json (development only):
   Place your serviceAccountKey.json in the 'server/' directory or the project root.
`);
      } else {
        console.error(`
🚀 Recommended Actions:
Configure the required environment variables securely via your hosting provider (e.g., Render Dashboard):
- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
`);
      }
      if (isProduction) {
        process.exit(1); // Fail fast in production
      } else {
        console.warn('⚠️ [Firebase Admin] Running in local development mode with uninitialized Firebase Admin.');
      }
    } else {
      isInitialized = true;
      initDurationMs = Date.now() - initStartTime;
      const discoveredProjectId = (app.options && app.options.projectId) || projectId || 'Discovered Automatically';
      console.log(`
✅ [Firebase Admin] Initialization Success:
Environment: ${isProduction ? 'Production' : 'Development'}
Credential Source: ${activeCredentialSource}
Firebase Project: ${discoveredProjectId}
Duration: ${initDurationMs}ms
Status: Initialized Successfully
`);
    }
  } else {
    app = getApps[0];
    isInitialized = true;
    activeCredentialSource = 'Cached Instance';
    initDurationMs = Date.now() - initStartTime;
  }
} catch (error) {
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    process.exit(1);
  } else {
    console.warn("⚠️ [Firebase Admin] Initialization error in development:", error.message || error);
  }
}

// Initialize services using modular APIs where applicable
// Note: Firestore and Storage require Google service account / ADC credentials.
// In development token verifier mode (Project ID only), only auth is functional.
const hasGcpCredentials = activeCredentialSource !== 'None' && activeCredentialSource !== 'Project ID Token Verifier';
const db = (app && hasGcpCredentials) ? getFirestore(app) : null;
const auth = app ? getAuth(app) : null;
const storage = (app && hasGcpCredentials) ? getStorage(app) : null;

// Only log once during initial require
if (!global.__FIREBASE_ADMIN_LOGGED && isInitialized) {
  if (db) {
    console.log("[Firebase Admin] Firestore connected");
  } else {
    console.log("[Firebase Admin] Auth initialized (Firestore in local file/offline mode)");
  }
  global.__FIREBASE_ADMIN_LOGGED = true;
}

// Self-test functionality
async function performSelfTest() {
  const testResults = {
    firestore: 'untested',
    auth: 'untested',
    totalDurationMs: 0
  };
  
  if (!isInitialized) return testResults;

  const testStartTime = Date.now();
  
  try {
    // Lightweight Firestore test
    if (db) {
      const firestoreStartTime = Date.now();
      await db.collection('_system_health_').limit(1).get();
      testResults.firestore = 'connected';
      testResults.firestoreDurationMs = Date.now() - firestoreStartTime;
    } else {
      testResults.firestore = 'skipped (no credentials)';
    }
  } catch (err) {
    console.warn('⚠️ [Firebase Admin] Firestore self-test failed:', err.message);
    testResults.firestore = 'failed';
  }

  try {
    // Lightweight Auth test
    const authStartTime = Date.now();
    await auth.listUsers(1);
    testResults.auth = 'connected';
    testResults.authDurationMs = Date.now() - authStartTime;
  } catch (err) {
    console.warn('⚠️ [Firebase Admin] Auth self-test failed:', err.message);
    testResults.auth = 'failed';
  }
  
  testResults.totalDurationMs = Date.now() - testStartTime;
  
  return testResults;
}

module.exports = {
  admin,
  app,
  db,
  auth,
  storage,
  FieldValue,
  Timestamp,
  isInitialized,
  credentialSource: activeCredentialSource,
  initDurationMs,
  performSelfTest
};
