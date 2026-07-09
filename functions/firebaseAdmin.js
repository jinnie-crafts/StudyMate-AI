const admin = require('firebase-admin');
const { cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');

require('dotenv').config();

// Helper to determine project ID
function getProjectId() {
  return process.env.FIREBASE_PROJECT_ID || "";
}

let app;

try {
  const getApps = admin.apps || (admin.app ? [admin.app()] : []);
  
  if (!Array.isArray(getApps) || getApps.length === 0) {
    const projectId = getProjectId();
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_CONFIG || process.env.FUNCTIONS_EMULATOR) {
      app = admin.initializeApp();
      console.log(`[Firebase Admin - Functions] Firebase initialized automatically via Cloud Environment`);
    } else if (projectId && clientEmail && privateKey) {
      const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
      const credential = cert({
        projectId,
        clientEmail,
        privateKey: formattedPrivateKey
      });
      app = admin.initializeApp({ credential, projectId });
      console.log(`[Firebase Admin - Functions] Firebase initialized via Environment Variables`);
    } else {
      throw new Error("Missing Firebase credentials (GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_CONFIG, or Env Variables)");
    }
  } else {
    app = getApps[0];
  }
} catch (error) {
  console.error("\n❌ [Firebase Admin - Functions] Initialization Error:");
  console.error(error.message || error);
  console.error("Please configure your Firebase Admin credentials correctly.\n");
  process.exit(1); // Fail fast
}

// Initialize services using modular APIs where applicable
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

module.exports = {
  admin,
  app,
  db,
  auth,
  storage,
  FieldValue,
  Timestamp
};
