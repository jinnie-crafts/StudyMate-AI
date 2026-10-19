import { auth, db } from "./firebase.js";
import { validateEmail, isDisposableEmailSync } from "./disposableEmailValidator.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  updateProfile,
  sendEmailVerification,
  GoogleAuthProvider,
  signInWithPopup,
  getAdditionalUserInfo,
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { LEGAL_CONFIG } from "./config/legalConfig.js";
import {
  doc,
  setDoc as rawSetDoc,
  getDoc,
  updateDoc as rawUpdateDoc,
  collection,
  addDoc as rawAddDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  deleteDoc,
  getDocs,
  Timestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { initNotifications, stopNotifications } from "./notificationBell.js";
import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";
import hljs from "https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/+esm";
import { spaNavigation } from "./spaNavigation.js";
import { populateModelSelect, invalidateModelCache } from "./modelRegistryClient.js";

const PASSWORD_DELETE_PROTECTION_DAYS = 3;

// ---------------------------------------------------------------------------
// Network Layer Hardening (Safe Fetch Wrapper)
// ---------------------------------------------------------------------------

window.__FIRESTORE_DEBUG__ = false;

function sanitizeFirestorePayload(payload) {
  if (payload === null || typeof payload !== "object") return payload;

  // Preserve Firebase special objects (Timestamp, FieldValue, Date)
  if (payload.constructor && payload.constructor.name !== "Object" && payload.constructor.name !== "Array") {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map(item => sanitizeFirestorePayload(item)).filter(item => item !== undefined);
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || Number.isNaN(value)) continue; // Strip undefined & NaN
    sanitized[key] = sanitizeFirestorePayload(value);
  }
  return sanitized;
}

const addDoc = async (collectionRef, data) => {
  const sanitized = sanitizeFirestorePayload(data);
  if (window.__FIRESTORE_DEBUG__) {
    console.log("[Firestore Path]", collectionRef.path);
    console.log("[Firestore Payload]", JSON.stringify(sanitized, null, 2));
    console.log("[Auth UID]", auth.currentUser?.uid);
    console.log("[Current Chat]", state.currentChatId);
  }
  if (!auth.currentUser?.uid) throw new Error("Auth not ready");
  try {
    return await rawAddDoc(collectionRef, sanitized);
  } catch (err) {
    if (window.__FIRESTORE_DEBUG__) {
      console.error("[Firestore Error Code]", err.code);
      console.error("[Firestore Error Message]", err.message);
      console.error("[Firestore Full Error]", err);
    }
    throw err;
  }
};

const setDoc = async (docRef, data, options) => {
  const sanitized = sanitizeFirestorePayload(data);
  if (window.__FIRESTORE_DEBUG__) {
    console.log("[Firestore Path]", docRef.path);
    console.log("[Firestore Payload]", JSON.stringify(sanitized, null, 2));
    console.log("[Auth UID]", auth.currentUser?.uid);
    console.log("[Current Chat]", state.currentChatId);
  }
  if (!auth.currentUser?.uid) throw new Error("Auth not ready");
  try {
    return await rawSetDoc(docRef, sanitized, options);
  } catch (err) {
    if (window.__FIRESTORE_DEBUG__) {
      console.error("[Firestore Error Code]", err.code);
      console.error("[Firestore Error Message]", err.message);
      console.error("[Firestore Full Error]", err);
    }
    throw err;
  }
};

const updateDoc = async (docRef, data) => {
  const sanitized = sanitizeFirestorePayload(data);
  if (window.__FIRESTORE_DEBUG__) {
    console.log("[Firestore Path]", docRef.path);
    console.log("[Firestore Payload]", JSON.stringify(sanitized, null, 2));
    console.log("[Auth UID]", auth.currentUser?.uid);
    console.log("[Current Chat]", state.currentChatId);
  }
  if (!auth.currentUser?.uid) throw new Error("Auth not ready");
  try {
    return await rawUpdateDoc(docRef, sanitized);
  } catch (err) {
    if (window.__FIRESTORE_DEBUG__) {
      console.error("[Firestore Error Code]", err.code);
      console.error("[Firestore Error Message]", err.message);
      console.error("[Firestore Full Error]", err);
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------

const DEBUG_FETCH = false;
const originalFetch = window.fetch;

window.fetch = async function (...args) {
  try {
    // 1. Safely extract URL (Handle string, Request object, and nulls)
    let url = "";
    if (typeof args[0] === "string") {
      url = args[0];
    } else if (args[0] instanceof Request) {
      url = args[0].url;
    } else {
      url = (args[0] && typeof args[0] === "object" && "url" in args[0]) ? args[0].url : String(args[0] || "");
    }

    // 2. Safe debugging
    if (DEBUG_FETCH && url.includes("/api/chat")) {
      console.log("[FETCH DEBUG] Intercepting AI request:", url);
    }

    // 3. Scoped Agent Logic (Strictly /api/chat only)
    if (url.includes("/api/chat")) {
      // Future agent logic goes here (Read-only for now)
      // Do NOT mutate headers or body at this stage
    }

    // 4. Transparent pass-through
    return await originalFetch(...args);
  } catch (err) {
    // 5. Fail-soft: Never block the request if the wrapper crashed
    console.error("[FETCH WRAPPER ERROR]", err);
    try {
      return await originalFetch(...args);
    } catch (criticalErr) {
      throw criticalErr; // Re-throw the actual network error if original fetch fails
    }
  }
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? (window.location.port === "3001" ? "" : `http://${window.location.hostname}:3001`)
  : (window.location.hostname.includes("onrender.com") ? "" : "https://api.aadirishi.in");

const page = document.body.dataset.page;
const FLASH_TOAST_KEY = "studymate_flash_toast";
const WELCOME_SEEN_KEY = "hasSeenWelcome";
const GUEST_QUESTION_LIMIT = 5;
const GUEST_USAGE_KEY = "studymate_guest_question_count";
const STORAGE_KEYS = { theme: "theme", defaultMode: "defaultMode", hinglishDefault: "hinglishDefault", defaultNotesMode: "defaultNotesMode", lastActiveChatId: "studymate_lastActiveChatId", deviceSessionId: "studymate_device_session_id" };
const MODES = ["general", "exam", "coding"];
const MODE_LABELS = {
  general: "🧠 General",
  exam: "📚 Exam Mode",
  coding: "💻 Coding Mode"
};
const AVAILABLE_MODES = MODES;
const AVAILABLE_NOTES_MODES = ["normal", "bullet", "revision", "flashcards"];
const AVAILABLE_THEMES = ["dark", "light", "blue", "purple"];
const REALTIME_QUERY_REGEX = /(today|now|latest|news|current|recent|weather|price|score|stock|time)/i;
const STREAM_WORD_DELAY_MS = 20;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  currentUser: null, chats: [], currentChatId: null, editingChatId: null,
  renameDraft: "", isSending: false, showTypingIndicator: false,
  editingMessageIndex: null, messageDraft: "", chatsUnsubscribe: null,
  preferredChatId: null, streamingResponse: null,
  trackerData: { questionsToday: 0, streakCount: 0 },
  isGuestMode: false,
  guestQuestionsUsed: 0,
  currentQuestion: null,
  userSettings: {
    aiModel: "auto",
    aiStyle: "detailed",
    aiTone: "professional",
    autoQuestion: true,
    fontSize: 16
  },
  userMemory: []
};

let ui = null;
let isHandlingOnboardingStart = false;
let hasInitializedWelcomeBindings = false;
let hasEvaluatedOnboardingForUser = false;
let lastOnboardingEvalUid = null;
let dashboardInitStartedForUid = null;
const feedbackUi = {
  initialized: false, toastContainer: null, confirmModal: null,
  confirmLabel: null, confirmTitle: null, confirmMessage: null,
  confirmCancelBtn: null, confirmOkBtn: null, confirmResolver: null
};

// Skeleton boot timestamp — captured immediately at module parse time
const __skeletonBootTime = Date.now();

const markdownRenderer = new marked.Renderer();

markdownRenderer.code = (code, language) => {
  const rawCode = typeof code === "string" ? code : String(code?.text || "");
  const rawLanguage = typeof language === "string"
    ? language
    : String(code?.lang || "");
  const lang = rawLanguage.trim().split(/\s+/)[0].toLowerCase();

  // Handle Mermaid diagrams
  if (lang === "mermaid") {
    // If we are currently streaming a response, DO NOT render mermaid to prevent parser crashes.
    // We output a placeholder/code block that will be transformed into SVG after streaming stops.
    if (state.streamingResponse && !state.streamingResponse.isCancelled) {
      return `<div class="code-block"><div class="code-header"><span>mermaid (rendering...)</span></div><pre><code class="hljs language-mermaid">${escapeHtml(rawCode)}</code></pre></div>`;
    }
    return `<div class="mermaid-container"><div class="mermaid">${escapeHtml(rawCode)}</div></div>`;
  }

  const hasLang = lang && hljs.getLanguage(lang);
  const highlighted = hasLang
    ? hljs.highlight(rawCode, { language: lang }).value
    : hljs.highlightAuto(rawCode).value;
  const label = escapeHtml(lang || "code");
  const langClass = lang ? ` language-${escapeAttribute(lang)}` : "";

  return `<div class="code-block"><div class="code-header"><span>${label}</span><button class="copy-btn" type="button" data-copy-code>Copy</button></div><pre><code class="hljs${langClass}">${highlighted}</code></pre></div>`;
};

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer: markdownRenderer
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentUserId() {
  const user = auth.currentUser;
  if (!user) throw new Error("User not authenticated");
  return user.uid;
}

// ---------------------------------------------------------------------------
// Skeleton Loading System
// ---------------------------------------------------------------------------

/**
 * Hides a skeleton overlay with a minimum visible duration and smooth fade-out.
 * @param {string} skeletonId - The DOM id of the skeleton overlay element.
 * @param {number} [minVisibleMs=250] - Minimum time the skeleton stays visible.
 */
function hideSkeletonOverlay(skeletonId, minVisibleMs = 250) {
  const el = document.getElementById(skeletonId);
  if (!el) return;

  const elapsed = Date.now() - __skeletonBootTime;
  const remaining = Math.max(0, minVisibleMs - elapsed);

  setTimeout(() => {
    el.classList.add("skeleton-hidden");

    // Remove from DOM after the CSS opacity transition completes
    const onEnd = () => el.remove();
    el.addEventListener("transitionend", onEnd, { once: true });

    // Safety fallback if transitionend doesn't fire (e.g. display:none, detached)
    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, 400);
  }, remaining);
}

// ---------------------------------------------------------------------------
// Auth pages
// ---------------------------------------------------------------------------

function initLoginPage() {
  const loginForm = document.getElementById("loginForm");
  const authMessage = document.getElementById("authMessage");
  const googleLoginBtn = document.getElementById("googleLoginBtn");
  const forgotPasswordLink = document.getElementById("forgotPasswordLink");

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    if (!email || !password) {
      setFormMessage(authMessage, "Please enter your email and password.", "error");
      return;
    }

    try {
      setFormMessage(authMessage, "Logging in...", "success");
      const cred = await signInWithEmailAndPassword(auth, email, password);

      // Mandatory reload for real-time verification status
      await cred.user.reload();
      const updatedUser = auth.currentUser;

      const isGoogle = updatedUser.providerData[0]?.providerId === 'google.com';
      if (!updatedUser.emailVerified && !isGoogle) {
        // Not verified and not google
        await signOut(auth);
        showVerificationModal(updatedUser);
        setFormMessage(authMessage, "Please verify your email before logging in.", "error");
        return;
      }

      await ensureUserDocument(updatedUser);
      queueFlashToast("Logged in successfully.", "success");
      window.location.replace("/");
    } catch (err) {
      console.error("Login error:", err);
      setFormMessage(authMessage, "Invalid email or password.", "error");
      showToast("Invalid email or password.", "error");
    }
  });

  if (forgotPasswordLink) {
    const forgotModal = document.getElementById("forgotModal");
    const resetEmailInput = document.getElementById("resetEmail");
    const sendResetBtn = document.getElementById("sendResetBtn");
    const resetStatus = document.getElementById("resetStatus");
    const closeModalBtn = document.getElementById("closeModal");

    forgotPasswordLink.addEventListener("click", () => {
      if (forgotModal) forgotModal.classList.add("show");
      if (resetEmailInput) {
        resetEmailInput.value = document.getElementById("loginEmail").value.trim();
        resetEmailInput.focus();
      }
    });

    if (closeModalBtn) {
      closeModalBtn.addEventListener("click", () => {
        if (forgotModal) forgotModal.classList.remove("show");
        if (resetStatus) resetStatus.textContent = "";
      });
    }

    if (forgotModal) {
      forgotModal.addEventListener("click", (e) => {
        if (e.target === forgotModal) {
          forgotModal.classList.remove("show");
          if (resetStatus) resetStatus.textContent = "";
        }
      });
    }

    if (sendResetBtn) {
      sendResetBtn.addEventListener("click", async () => {
        const email = resetEmailInput.value.trim();
        if (!email) {
          resetStatus.textContent = "Please enter an email address.";
          resetStatus.className = "form-message error";
          return;
        }

        try {
          sendResetBtn.disabled = true;
          sendResetBtn.textContent = "Sending...";
          await sendPasswordResetEmail(auth, email, {
            url: window.location.origin
          });

          // Store for auto-login on reset page
          localStorage.setItem("resetEmail", email);

          resetStatus.textContent = "If an account exists, a reset link has been sent.";
          resetStatus.className = "form-message success";

          setTimeout(() => {
            if (forgotModal) forgotModal.classList.remove("show");
            sendResetBtn.disabled = false;
            sendResetBtn.textContent = "Send Reset Link";
            resetStatus.textContent = "";
          }, 4000);

        } catch (err) {
          console.error("Password reset error:", err);
          // Generic error for security
          resetStatus.textContent = "If an account exists, a reset link has been sent.";
          resetStatus.className = "form-message success";
          sendResetBtn.disabled = false;
          sendResetBtn.textContent = "Send Reset Link";
        }
      });
    }

    const closeResetCardBtn = document.getElementById("closeResetCard");
    if (closeResetCardBtn) {
      closeResetCardBtn.addEventListener("click", () => {
        const resetCard = document.getElementById("resetCard");
        if (resetCard) resetCard.classList.add("hidden");
      });
    }
  }

  googleLoginBtn.addEventListener("click", loginWithGoogle);
}

async function validateSignupEmail(email) {
  // Uses the robust disposableEmailValidator.js utility
  // Performs local check (3000+ domains + suffix matching) + remote API fallback
  // Throws with user-friendly message if disposable
  await validateEmail(email);
}

function initSignupPage() {
  const signupForm = document.getElementById("signupForm");
  const authMessage = document.getElementById("authMessage");
  const googleLoginBtn = document.getElementById("googleLoginBtn");

  let isSubmitting = false;
  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    const email = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value;

    if (!email || !password) {
      setFormMessage(authMessage, "Please fill in all fields.", "error");
      return;
    }

    const agreementCheckbox = document.getElementById("agreementCheckbox");
    if (agreementCheckbox && !agreementCheckbox.checked) {
      setFormMessage(authMessage, "You must agree to the Privacy Policy and User Agreement before creating an account.", "error");
      showToast("You must agree to the Privacy Policy and User Agreement before creating an account.", "error");
      agreementCheckbox.focus();
      return;
    }

    try {
      await validateSignupEmail(email);
    } catch (validationError) {
      const validationMessage = validationError?.message || "Signup failed";
      setFormMessage(authMessage, validationMessage, "error");
      showToast(validationMessage, "error");
      return;
    }

    try {
      isSubmitting = true;
      const submitBtn = signupForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      setFormMessage(authMessage, "Creating your secure account...", "success");

      try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        console.info(`[AUTH] Signup Success: ${user.email}`);

        // SEND VERIFICATION EMAIL
        try {
          console.info("[AUTH] Sending verification email...");
          await sendEmailVerification(user, {
            url: window.location.origin
          });
          console.info("[AUTH] Verification email sent successfully");
        } catch (emailError) {
          console.error("[AUTH] Verification email send failed:", emailError);
          // If sending email fails, delete the auth account to prevent unverified orphaned accounts
          await user.delete();
          setFormMessage(authMessage, "Failed to send verification email. Please try again later.", "error");
          
          isSubmitting = false;
          if (submitBtn) submitBtn.disabled = false;
          return;
        }

        // ENSURE FIRESTORE SYNC
        await ensureUserDocument(user, true, "email");

        // SHOW SUCCESS MESSAGE (Specific)
        setFormMessage(authMessage, "Verification email sent. Redirecting to verification page...", "success");

        // Do not sign out! The onAuthStateChanged listener will automatically 
        // trigger runAuthGuard which redirects unverified users to /verify.
        
        // Trigger modal is no longer needed since we redirect to a dedicated page
        // showVerificationModal(user);

      } catch (err) {
        console.error("Signup error:", err.code);
        if (err.code === "auth/email-already-in-use") {
          setFormMessage(authMessage, "Account already exists. Please login.", "error");
        } else {
          setFormMessage(authMessage, "Signup failed. Please try again.", "error");
        }
      }

    } catch (err) {
      console.error("Critical Signup error:", err);
      setFormMessage(authMessage, "An error occurred. Please try again.", "error");
      showToast(err.message, "error");
    } finally {
      isSubmitting = false;
      const submitBtn = signupForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  if (googleLoginBtn) googleLoginBtn.addEventListener("click", loginWithGoogle);
}

function showVerificationModal(user) {
  const modal = document.getElementById("verifyModal");
  if (!modal) return;

  modal.classList.add("show");

  const resendBtn = document.getElementById("resendVerifyBtn");
  const statusEl = document.getElementById("verifyStatus");
  const closeBtn = document.getElementById("closeVerifyModal");

  let cooldown = 0;
  let timerInterval = null;

  const startCooldown = () => {
    const timestamp = Date.now();
    localStorage.setItem("lastResendTimestamp", timestamp);
    resendBtn.classList.add("disabled");
    resendBtn.disabled = true;

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - timestamp) / 1000);
      cooldown = 60 - elapsed;
      resendBtn.textContent = `Resend available in ${cooldown}s`;
      if (cooldown <= 0) {
        clearInterval(timerInterval);
        resendBtn.classList.remove("disabled");
        resendBtn.disabled = false;
        resendBtn.textContent = "Resend Email";
        localStorage.removeItem("lastResendTimestamp");
      }
    }, 1000);
  };

  // Check for existing cooldown on modal open
  const savedTimestamp = localStorage.getItem("lastResendTimestamp");
  if (savedTimestamp) {
    const elapsed = Math.floor((Date.now() - parseInt(savedTimestamp)) / 1000);
    if (elapsed < 60) {
      startCooldown();
    }
  }

  resendBtn.onclick = async () => {
    try {
      statusEl.textContent = "Sending verification...";
      statusEl.className = "verify-status waiting";

      // If user is signed out, we might need them to sign in again or just use the link
      // But Firebase allows sending toCurrentUser if they just signed up
      console.log("Resending verification email to:", user.email || (auth.currentUser ? auth.currentUser.email : "Unknown"));
      await sendEmailVerification(auth.currentUser || user, {
        url: window.location.origin
      });

      statusEl.textContent = "New verification link sent!";
      statusEl.className = "verify-status success";
      startCooldown();
    } catch (err) {
      statusEl.textContent = "Failed to resend. Please try again later.";
      statusEl.className = "verify-status error";
    }
  };

  closeBtn.onclick = () => {
    modal.classList.remove("show");
    if (timerInterval) clearInterval(timerInterval);
  };
}

async function loginWithGoogle() {
  try {
    const agreementCheckbox = document.getElementById("agreementCheckbox");
    if (agreementCheckbox && !agreementCheckbox.checked) {
      showToast("You must agree to the Privacy Policy and User Agreement before creating an account.", "error");
      agreementCheckbox.focus();
      return;
    }

    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    const { isNewUser } = getAdditionalUserInfo(result);


    await ensureUserDocument(result.user, isNewUser, "google");
    queueFlashToast("Signed in with Google.", "success");
    window.location.replace("/");
  } catch (err) { console.error("Google login error:", err); showToast(err.message, "error"); }
}

// ---------------------------------------------------------------------------
// Firestore user document
// ---------------------------------------------------------------------------

async function ensureUserDocument(user, isNewUser = false, authProvider = null) {
  if (!user) return null;
  try {
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      const newUserDoc = {
        uid: user.uid,
        name: user.displayName || "User",
        displayName: user.displayName || "User",
        email: user.email || "",
        photoURL: user.photoURL || "",
        provider: authProvider || "email",
        emailVerified: user.emailVerified || false,
        createdAt: serverTimestamp(),
        lastLogin: serverTimestamp(),
        accountStatus: "active",
        role: "user",
        subscription: "free",
        plan: "free",
        isBlocked: false,
        isPremium: false,
        isAdmin: false,
        onboardingDone: false,
        hasSeenWelcome: false
      };

      if (isNewUser) {
        newUserDoc.acceptedPrivacyPolicy = true;
        newUserDoc.acceptedTerms = true;
        newUserDoc.agreementAccepted = true; // Legacy support
        newUserDoc.agreementAcceptedAt = serverTimestamp();
        newUserDoc.agreementAcceptedVersion = typeof LEGAL_CONFIG !== 'undefined' ? LEGAL_CONFIG.agreementVersion : "1.2.0";
        newUserDoc.agreementAcceptedMethod = authProvider;
        newUserDoc.agreementAcceptedUserAgent = navigator.userAgent;
        newUserDoc.verificationEmailSentAt = serverTimestamp();
      }

      await setDoc(userRef, newUserDoc, { merge: true });
      state.userOnboardingDone = false;
      
      // Fire-and-forget welcome notification for new users
      sendWelcomeNotification(user.uid);
      return newUserDoc;
    } else {
      const data = snap.data();
      const hasSeenWelcome = Boolean(data.hasSeenWelcome ?? data.onboardingDone ?? false);
      state.userOnboardingDone = hasSeenWelcome;
      
      const profilePatch = {
        name: user.displayName || data.name || data.displayName || "User",
        displayName: user.displayName || data.displayName || data.name || "User",
        email: user.email || data.email || "",
        photoURL: user.photoURL || data.photoURL || "",
        lastLogin: serverTimestamp(),
        emailVerified: user.emailVerified || data.emailVerified || false
      };

      // Set defaults for existing users if missing
      if (data.provider === undefined && authProvider) profilePatch.provider = authProvider;
      if (data.accountStatus === undefined) profilePatch.accountStatus = "active";
      if (data.role === undefined) profilePatch.role = "user";
      if (data.subscription === undefined) profilePatch.subscription = "free";
      if (data.plan === undefined) profilePatch.plan = "free";
      if (data.isBlocked === undefined) profilePatch.isBlocked = false;
      if (data.isPremium === undefined) profilePatch.isPremium = false;
      if (data.isAdmin === undefined) profilePatch.isAdmin = false;
      
      if (data.hasSeenWelcome === undefined) {
        profilePatch.hasSeenWelcome = hasSeenWelcome;
      }



      await setDoc(userRef, profilePatch, { merge: true });
      return { ...data, ...profilePatch };
    }
  } catch (error) {
    console.error("Error ensuring user document:", error);
    if (error.code === "permission-denied") {
      showToast("Access denied");
    } else {
      showToast("Something went wrong");
    }
    return null;
  }
}


async function loadTrackerData() {
  if (!state.currentUser) return;
  try {
    const snap = await getDoc(doc(db, "users", state.currentUser.uid));
    if (!snap.exists()) return;
    const data = snap.data();
    const today = todayString();
    if (data.lastActiveDate !== today) {
      state.trackerData.questionsToday = 0;
    } else {
      state.trackerData.questionsToday = data.questionsToday || 0;
    }
    state.trackerData.streakCount = data.streakCount || 0;
    renderTracker();
  } catch (err) { console.error("loadTrackerData error:", err); }
}

async function incrementStudyTracker() {
  if (!state.currentUser) return;
  try {
    const userRef = doc(db, "users", state.currentUser.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) return;
    const data = snap.data();
    const today = todayString();
    const yesterday = yesterdayString();
    let questionsToday = data.questionsToday || 0;
    let streakCount = data.streakCount || 0;

    if (data.lastActiveDate === today) {
      questionsToday += 1;
    } else {
      questionsToday = 1;
      if (data.lastActiveDate === yesterday) { streakCount += 1; }
      else { streakCount = 1; }
    }

    await updateDoc(userRef, { questionsAsked: (data.questionsAsked || 0) + 1, questionsToday, lastActiveDate: today, streakCount });
    state.trackerData.questionsToday = questionsToday;
    state.trackerData.streakCount = streakCount;
    renderTracker();
  } catch (err) { console.error("incrementStudyTracker error:", err); }
}

function renderTracker() {
  const qtEl = document.getElementById("questionsToday");
  const skEl = document.getElementById("streakCount");
  if (qtEl) qtEl.textContent = state.trackerData.questionsToday;
  if (skEl) skEl.textContent = state.trackerData.streakCount;
}

function todayString() { return new Date().toISOString().slice(0, 10); }
function yesterdayString() { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function initDashboardPage() {
  ui = Object.assign(ui || {}, {
    body: document.body,
    newChatBtn: document.getElementById("newChatBtn"),
    chatHistoryList: document.getElementById("chatHistoryList"),
    chatMessages: document.getElementById("chatMessages"),
    chatForm: document.getElementById("chatForm"),
    userInput: document.getElementById("userInput"),
    sendBtn: document.getElementById("sendBtn"),
    modeDropdown: document.getElementById("modeDropdown"),
    selectedMode: document.getElementById("selectedMode"),
    dropdownOptions: document.getElementById("dropdownOptions"),
    notesDropdown: document.getElementById("notesDropdown"),
    notesSelected: document.getElementById("notesSelected"),
    notesDropdownOptions: document.getElementById("notesDropdownOptions"),
    hinglishToggle: document.getElementById("hinglishToggle"),
    profileBtn: document.getElementById("profileBtn"),
    profileDropdown: document.getElementById("profileDropdown"),
    userShortName: document.getElementById("userShortName"),
    userAvatar: document.getElementById("userAvatar"),
    dropdownAvatar: document.getElementById("dropdownAvatar"),
    dropdownUserName: document.getElementById("userName"),
    dropdownUserEmail: document.getElementById("userEmail"),
    settingsBtn: document.getElementById("settingsBtn"),
    editNameBtn: document.getElementById("editNameBtn"),
    editNameModal: document.getElementById("editNameModal"),
    newNameInput: document.getElementById("newNameInput"),
    saveNameBtn: document.getElementById("saveNameBtn"),
    cancelBtn: document.getElementById("cancelBtn"),
    logoutBtn: document.getElementById("logoutBtn"),
    menuToggleBtn: document.getElementById("menuToggleBtn"),
    sidebarOverlay: document.getElementById("sidebarOverlay"),
    guestLimitModal: document.getElementById("guestLimitModal"),
    guestLimitText: document.getElementById("guestLimitText"),
    guestLoginBtn: document.getElementById("guestLoginBtn"),
    guestSignupBtn: document.getElementById("guestSignupBtn"),
    guestLaterBtn: document.getElementById("guestLaterBtn"),
    changelogView: document.getElementById("changelogView"),
    changelogContent: document.getElementById("changelogContent"),
    changelogBackBtn: document.getElementById("changelogBackBtn"),
    changelogBtn: document.getElementById("changelogBtn")
  });

  hideOnboardingOverlay();
  bindDashboardEvents();

  if (state.isGuestMode) {
    initializeGuestDashboard();
  }
}

function initializeGuestDashboard() {
  closeGuestLimitModal();
  cleanupChatSubscription();
  state.isGuestMode = true;
  state.currentUser = null;
  state.chats = [];
  state.currentChatId = null;
  state.preferredChatId = null;
  state.editingChatId = null;
  state.renameDraft = "";
  state.editingMessageIndex = null;
  state.messageDraft = "";
  state.showTypingIndicator = false;
  state.guestQuestionsUsed = loadGuestQuestionUsage();

  displayUserProfile("Guest", "Login to save chat history", "");
  if (ui.logoutBtn) ui.logoutBtn.textContent = "Login";
  if (ui.editNameBtn) {
    ui.editNameBtn.disabled = true;
    ui.editNameBtn.title = "Please log in to edit your profile";
  }

  setSelectedMode(getSavedDefaultMode());
  setSelectedNotesMode(getSavedDefaultNotesMode());
  bindNotesModeControls();
  bindHinglishToggle();
  initVersioning();

  ui.hinglishToggle.checked = getSavedHinglishDefault();

  renderHistory();
  renderMessages();

  // Hide skeleton after guest dashboard is fully rendered
  hideSkeletonOverlay("dashboardSkeleton");
}

function loadGuestQuestionUsage() {
  const raw = localStorage.getItem(GUEST_USAGE_KEY);
  const parsed = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function saveGuestQuestionUsage(count) {
  localStorage.setItem(GUEST_USAGE_KEY, String(Math.max(0, count)));
}

function isGuestUsageLimitReached() {
  return state.isGuestMode && state.guestQuestionsUsed >= GUEST_QUESTION_LIMIT;
}

function incrementGuestQuestionUsage() {
  if (!state.isGuestMode) return;
  state.guestQuestionsUsed += 1;
  saveGuestQuestionUsage(state.guestQuestionsUsed);
}

function showGuestLimitModal() {
  if (!ui?.guestLimitModal) return;
  if (ui.guestLimitText) {
    const remaining = Math.max(0, GUEST_QUESTION_LIMIT - state.guestQuestionsUsed);
    ui.guestLimitText.textContent = remaining > 0
      ? `You have ${remaining} guest question${remaining === 1 ? "" : "s"} left.`
      : `You have reached the ${GUEST_QUESTION_LIMIT}-question guest limit.`;
  }
  ui.guestLimitModal.classList.add("show");
  ui.guestLimitModal.setAttribute("aria-hidden", "false");
}

function closeGuestLimitModal() {
  if (!ui?.guestLimitModal) return;
  ui.guestLimitModal.classList.remove("show");
  ui.guestLimitModal.setAttribute("aria-hidden", "true");
}

function createGuestMessage(role, content, sources = []) {
  return {
    id: `guest-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    sources: normalizeSources(sources),
    createdAt: Timestamp.now()
  };
}

function showOnboardingOverlay() {
  const overlay = document.querySelector(".welcome-modal") || document.getElementById("onboarding");
  const startBtn = document.getElementById("getStartedBtn") || document.getElementById("startBtn");
  if (!overlay || !startBtn) return;

  const uid = state.currentUser?.uid || "";
  if (getLocalWelcomeSeen(uid) === "true") {
    hideOnboardingOverlay();
    state.userOnboardingDone = true;
    return;
  }

  overlay.classList.remove("hidden");
  overlay.classList.add("open");
  overlay.style.display = "flex";
  overlay.style.pointerEvents = "auto";
  overlay.setAttribute("aria-hidden", "false");
  startBtn.disabled = false;
  startBtn.textContent = "Get Started";

  // Highlight New Chat briefly
  const newChatBtn = document.getElementById("newChatBtn");
  if (newChatBtn) {
    newChatBtn.style.boxShadow = "0 0 20px #3b82f6";
    setTimeout(() => { if (newChatBtn) newChatBtn.style.boxShadow = ""; }, 3000);
  }

  bindOnboardingStartButton();
}

function hideOnboardingOverlay() {
  const overlay = document.querySelector(".welcome-modal") || document.getElementById("onboarding");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.classList.remove("open");
  overlay.style.display = "none";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.pointerEvents = "none";
  document.body.style.pointerEvents = "";
}

function initWelcomeModalBindings() {
  if (hasInitializedWelcomeBindings) return;
  hasInitializedWelcomeBindings = true;

  if (shouldSkipOnboardingModal()) return;

  const overlay = document.querySelector(".welcome-modal") || document.getElementById("onboarding");
  const startBtn = document.getElementById("getStartedBtn");
  if (!overlay || !startBtn) return;

  bindOnboardingStartButton();
  const hasSeen = getLocalWelcomeSeen(state.currentUser?.uid || "");
  console.log("hasSeenWelcome:", hasSeen);
  if (hasSeen === "true") {
    hideOnboardingOverlay();
  }
}

function bindOnboardingStartButton() {
  const startBtn = document.getElementById("getStartedBtn");
  if (startBtn && startBtn.dataset.onboardingBound !== "true") {
    startBtn.dataset.onboardingBound = "true";
    startBtn.setAttribute("type", "button");
    const handleClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleStart();
    };
    startBtn.addEventListener("click", handleClick);
  }
}

function shouldSkipOnboardingModal() {
  if (page !== "dashboard") return true;
  const path = window.location.pathname.toLowerCase();
  return path.includes("/login");
}

function getWelcomeSeenStorageKey(uid = "") {
  return uid ? `${WELCOME_SEEN_KEY}:${uid}` : WELCOME_SEEN_KEY;
}

function getLocalWelcomeSeen(uid = "") {
  const key = getWelcomeSeenStorageKey(uid);
  return localStorage.getItem(key);
}

function persistLocalWelcomeSeen(uid, seen = true) {
  const value = seen ? "true" : "false";
  localStorage.setItem(WELCOME_SEEN_KEY, value);
  if (uid) {
    localStorage.setItem(getWelcomeSeenStorageKey(uid), value);
  }
}

function startDashboardApp(user) {
  const uid = user?.uid;
  if (!uid || dashboardInitStartedForUid === uid) return;
  dashboardInitStartedForUid = uid;

  // 1. Determine target chat from localStorage
  const targetChatId = getPersistedLastActiveChatId(uid);

  // 2. Hydrate via existing listener path
  loadChats(targetChatId || undefined);

  // 4. Handle initial SPA view routing (e.g. ?view=changelog)

  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "changelog") {
    toggleChangelogView(true);
  }


  loadTrackerData();
  initNotifications(uid);
}

async function maybeHandleOnboardingForUser(user) {
  const uid = user?.uid;
  if (!uid || shouldSkipOnboardingModal()) return true;

  if (lastOnboardingEvalUid !== uid) {
    lastOnboardingEvalUid = uid;
    hasEvaluatedOnboardingForUser = false;
    dashboardInitStartedForUid = null;
  }
  if (hasEvaluatedOnboardingForUser) {
    return state.userOnboardingDone === true;
  }

  const localHasSeen = getLocalWelcomeSeen(uid) === "true";
  let firestoreHasSeen = false;
  try {
    const userSnap = await getDoc(doc(db, "users", uid));
    if (userSnap.exists()) {
      const userData = userSnap.data();
      firestoreHasSeen = Boolean(userData.hasSeenWelcome ?? userData.onboardingDone ?? false);
    }
  } catch (error) {
    console.error("Onboarding status read error:", error);
  }

  const hasSeenWelcome = firestoreHasSeen || localHasSeen;
  console.log("hasSeenWelcome:", String(hasSeenWelcome));
  state.userOnboardingDone = hasSeenWelcome;

  if (hasSeenWelcome) {
    persistLocalWelcomeSeen(uid, true);
    hideOnboardingOverlay();
    hasEvaluatedOnboardingForUser = true;
    return true;
  }

  showOnboardingOverlay();
  hasEvaluatedOnboardingForUser = true;
  return false;
}

async function handleStart() {
  const overlay = document.querySelector(".welcome-modal") || document.getElementById("onboarding");
  const startBtn = document.getElementById("getStartedBtn") || document.getElementById("startBtn");
  if (!overlay || !startBtn) return;
  if (isHandlingOnboardingStart) return;
  isHandlingOnboardingStart = true;

  const activeUser = state.currentUser;
  const activeUid = activeUser?.uid || "";

  try {
    console.log("Get Started clicked");
    startBtn.disabled = true;
    startBtn.textContent = "Setting up...";
    persistLocalWelcomeSeen(activeUid, true);
    hasEvaluatedOnboardingForUser = true;
    state.userOnboardingDone = true;
    hideOnboardingOverlay();

    try {
      // Persistence: Update Firestore
      if (activeUid) {
        const userRef = doc(db, "users", activeUid);
        await updateDoc(userRef, {
          onboardingDone: true,
          hasSeenWelcome: true
        });
      }
    } catch (err) {
      console.error("Onboarding setup error:", err);
    }

    // Welcome message in chat (Prevention of duplicates)
    if (ui.chatMessages && !sessionStorage.getItem("welcomeMessageSent")) {
      const welcomeMsg = document.createElement("div");
      welcomeMsg.className = "message ai-message";
      welcomeMsg.innerHTML = `<p>Hi! I'm StudyMate AI 👋 What would you like to learn today? I can help with General, Exam, or Coding topics!</p>`;
      ui.chatMessages.appendChild(welcomeMsg);
      scrollMessagesToBottom();
      sessionStorage.setItem("welcomeMessageSent", "true");
    }

    // Auto focus input
    if (ui.userInput) {
      ui.userInput.placeholder = "Ask anything...";
      ui.userInput.focus();
    }

    if (activeUser) {
      startDashboardApp(activeUser);
    }
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Get Started";
    isHandlingOnboardingStart = false;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function initSettingsPage() {
  ui = Object.assign(ui || {}, {
    settingsNameInput: document.getElementById("settingsNameInput"),
    settingsEmailInput: document.getElementById("settingsEmailInput"),
    settingsAvatarUrlInput: document.getElementById("settingsAvatarUrlInput"),
    settingsAvatarPreview: document.getElementById("settingsAvatarPreview"),
    settingsDisplayHeader: document.getElementById("settingsDisplayHeader"),
    settingsEmailHeader: document.getElementById("settingsEmailHeader"),
    saveAccountBtn: document.getElementById("saveAccountBtn"),

    changePasswordBtn: document.getElementById("changePasswordBtn"),
    logoutAllSessionsBtn: document.getElementById("logoutAllSessionsBtn"),

    aiModelSelect: document.getElementById("aiModelSelect"),
    aiModelDetailsContainer: document.getElementById("aiModelDetailsContainer"),
    aiStyleSelect: document.getElementById("aiStyleSelect"),
    aiToneSelect: document.getElementById("aiToneSelect"),
    autoQuestionToggle: document.getElementById("autoQuestionToggle"),

    statsTotalRequests: document.getElementById("statsTotalRequests"),
    statsTokensUsed: document.getElementById("statsTokensUsed"),

    themeSelector: document.getElementById("themeSelector"),
    appLanguageSelect: document.getElementById("appLanguageSelect"),
    fontSizeRange: document.getElementById("fontSizeRange"),

    fullLogoutBtn: document.getElementById("fullLogoutBtn"),
    clearAllHistoryBtn: document.getElementById("clearAllHistoryBtn"),
    downloadDataBtn: document.getElementById("downloadDataBtn"),
    deleteAccountBtn: document.getElementById("deleteAccountBtn"),
    googleAccountStatus: document.getElementById("googleAccountStatus")
  });

  if (ui.aiModelSelect) {
    populateModelSelect(ui.aiModelSelect, state.userSettings?.aiModel || "auto", ui.aiModelDetailsContainer).catch(err => {
      console.warn("[Settings] Model select populate failed:", err.message);
    });
  }

  bindSettingsEvents();
  renderSettingsPreferences();

  // Initialize Category Navigation Logic (Desktop sidebar + Mobile drill-down)
  const nav = document.getElementById("settingsNav");
  const mobileBackBtn = document.getElementById("settingsMobileBack");
  const settingsLayout = document.querySelector(".settings-layout");

  // Helper: detect mobile breakpoint
  const isMobile = () => window.innerWidth <= 768;

  if (nav && !nav.dataset.settingsNavBound) {
    nav.dataset.settingsNavBound = "true";
    const navItems = nav.querySelectorAll(".nav-item");
    const sections = document.querySelectorAll(".settings-card");

    // On mobile: start with menu visible, no section visible
    function showMobileMenu() {
      if (!isMobile()) return;
      if (settingsLayout) settingsLayout.classList.remove("section-active");
      sections.forEach(sec => sec.classList.add("hidden"));
      navItems.forEach(i => i.classList.remove("active"));
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    // On mobile: show only the selected section, hide menu
    function showMobileSection(sectionId) {
      if (settingsLayout) settingsLayout.classList.add("section-active");
      sections.forEach(sec => {
        if (sec.id === sectionId + "-section") {
          sec.classList.remove("hidden");
        } else {
          sec.classList.add("hidden");
        }
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    navItems.forEach(item => {
      item.addEventListener("click", () => {
        const target = item.dataset.section;

        // Update nav active state
        navItems.forEach(i => i.classList.remove("active"));
        item.classList.add("active");

        // Toggle sections visibility
        sections.forEach(sec => {
          if (sec.id === target + "-section") {
            sec.classList.remove("hidden");
          } else {
            sec.classList.add("hidden");
          }
        });

        // Mobile: switch to section view
        if (isMobile()) {
          showMobileSection(target);
        }

        // Scroll to top on navigation
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    // Mobile back button: return to menu
    if (mobileBackBtn) {
      mobileBackBtn.addEventListener("click", () => {
        showMobileMenu();
      });
    }

    // On initial load: if mobile, show menu only (no section active)
    if (isMobile()) {
      sections.forEach(sec => sec.classList.add("hidden"));
      navItems.forEach(i => i.classList.remove("active"));
      if (settingsLayout) settingsLayout.classList.remove("section-active");
    }

    // Handle resize: if switching from mobile to desktop, restore desktop layout
    window.addEventListener("resize", () => {
      if (!isMobile()) {
        if (settingsLayout) settingsLayout.classList.remove("section-active");
        // Ensure at least one section is visible on desktop
        const hasActive = nav.querySelector(".nav-item.active");
        if (!hasActive) {
          const firstNav = nav.querySelector(".nav-item");
          if (firstNav) {
            firstNav.classList.add("active");
            const firstTarget = firstNav.dataset.section;
            sections.forEach(sec => {
              sec.classList.toggle("hidden", sec.id !== firstTarget + "-section");
            });
          }
        }
      }
    });
  }
}

function bindSafeListener(element, eventType, handler) {
  if (!element) return;
  const boundAttr = `data-bound-${eventType}`;
  if (element.hasAttribute(boundAttr)) return;
  element.setAttribute(boundAttr, "true");
  element.addEventListener(eventType, handler);
}

function bindSettingsEvents() {
  if (ui.saveAccountBtn) bindSafeListener(ui.saveAccountBtn, "click", () => saveAccountProfile());
  if (ui.changePasswordBtn) bindSafeListener(ui.changePasswordBtn, "click", () => handleInAppPasswordChange());
  if (ui.logoutAllSessionsBtn) bindSafeListener(ui.logoutAllSessionsBtn, "click", () => confirmLogoutAll());
  if (ui.fullLogoutBtn) bindSafeListener(ui.fullLogoutBtn, "click", () => confirmLogoutAll());

  if (ui.aiModelSelect) bindSafeListener(ui.aiModelSelect, "change", () => saveUserSettings());
  if (ui.aiStyleSelect) bindSafeListener(ui.aiStyleSelect, "change", () => saveUserSettings());
  if (ui.aiToneSelect) bindSafeListener(ui.aiToneSelect, "change", () => saveUserSettings());
  if (ui.autoQuestionToggle) bindSafeListener(ui.autoQuestionToggle, "change", () => saveUserSettings());

  if (ui.themeSelector) {
    bindSafeListener(ui.themeSelector, "click", (e) => {
      const btn = e.target.closest(".theme-btn-card");
      if (!btn) return;
      setTheme(btn.dataset.theme);
      renderSettingsPreferences();
    });
  }

  if (ui.appLanguageSelect) bindSafeListener(ui.appLanguageSelect, "change", () => saveUserSettings());
  if (ui.fontSizeRange) {
    bindSafeListener(ui.fontSizeRange, "input", (e) => applyFontSize(e.target.value));
    bindSafeListener(ui.fontSizeRange, "change", () => saveUserSettings());
  }

  if (ui.clearAllHistoryBtn) bindSafeListener(ui.clearAllHistoryBtn, "click", () => clearCurrentUserChats());
  if (ui.downloadDataBtn) bindSafeListener(ui.downloadDataBtn, "click", () => exportUserData());
  if (ui.deleteAccountBtn) bindSafeListener(ui.deleteAccountBtn, "click", () => handleDeleteAccount());
}

async function loadUserSettings() {
  if (!state.currentUser) return;
  try {
    const snap = await getDoc(doc(db, "users", state.currentUser.uid));
    if (snap.exists()) {
      const data = snap.data();
      const settings = data.settings || {};

      state.userSettings = {
        aiModel: settings.aiModel || "auto",
        aiStyle: settings.aiStyle || "detailed",
        aiTone: settings.aiTone || "professional",
        autoQuestion: settings.autoQuestion !== false,
        language: settings.language || "en",
        fontSize: settings.fontSize || 16
      };

      if (ui.aiModelSelect) {
        populateModelSelect(ui.aiModelSelect, state.userSettings.aiModel, ui.aiModelDetailsContainer);
      }
      if (ui.aiStyleSelect) ui.aiStyleSelect.value = state.userSettings.aiStyle;
      if (ui.aiToneSelect) ui.aiToneSelect.value = state.userSettings.aiTone;
      if (ui.autoQuestionToggle) ui.autoQuestionToggle.checked = state.userSettings.autoQuestion;
      if (ui.appLanguageSelect) ui.appLanguageSelect.value = state.userSettings.language;
      if (ui.fontSizeRange) {
        ui.fontSizeRange.value = state.userSettings.fontSize;
        applyFontSize(state.userSettings.fontSize);
      }
    }
  } catch (err) {
    console.error("Load settings error:", err);
  }
}

async function loadUserMemory() {
  if (!state.currentUser) return;
  try {
    const memoryRef = collection(db, "users", state.currentUser.uid, "memory");
    const snap = await getDocs(memoryRef);
    state.userMemory = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    console.log(`[Memory] Loaded ${state.userMemory.length} memories from Firestore.`);
  } catch (err) {
    console.error("Failed to load user memory:", err);
  }
}

async function saveUserMemories(memories) {
  if (!state.currentUser || !memories || memories.length === 0) return;
  try {
    const memoryRef = collection(db, "users", state.currentUser.uid, "memory");
    for (const mem of memories) {
      const docRef = doc(memoryRef, mem.id || Date.now().toString());
      await setDoc(docRef, {
        fact: mem.fact,
        category: mem.category,
        confidence: mem.confidence,
        timestamp: mem.timestamp || Date.now()
      });
      state.userMemory.push(mem);
    }
    console.log(`[Memory] Saved ${memories.length} new memories to Firestore.`);
  } catch (err) {
    console.error("Failed to save memory updates:", err);
  }
}


async function saveUserSettings() {
  if (!state.currentUser) return;
  const settings = {
    aiModel: ui.aiModelSelect?.value || "auto",
    aiStyle: ui.aiStyleSelect?.value || "detailed",
    aiTone: ui.aiToneSelect?.value || "professional",
    autoQuestion: ui.autoQuestionToggle?.checked ?? true,
    language: ui.appLanguageSelect?.value || "en",
    fontSize: Number(ui.fontSizeRange?.value || 16)
  };

  state.userSettings = settings;

  try {
    await updateDoc(doc(db, "users", state.currentUser.uid), {
      settings,
      updatedAt: serverTimestamp()
    });
    localStorage.setItem("appSettings", JSON.stringify(settings));
    showToast("Preferences updated", "success");
  } catch (err) {
    console.error("Save settings error:", err);
    showToast("Failed to sync settings", "error");
  }
}

async function saveAccountProfile() {
  if (!state.currentUser) return;
  const newName = ui.settingsNameInput.value.trim();
  const newPhoto = ui.settingsAvatarUrlInput.value.trim();

  try {
    ui.saveAccountBtn.disabled = true;
    ui.saveAccountBtn.textContent = "Saving...";

    await updateProfile(state.currentUser, {
      displayName: newName,
      photoURL: newPhoto
    });

    await updateDoc(doc(db, "users", state.currentUser.uid), {
      displayName: newName,
      photoURL: newPhoto,
      updatedAt: serverTimestamp()
    });

    if (ui.settingsDisplayHeader) ui.settingsDisplayHeader.textContent = newName;
    if (ui.settingsAvatarPreview && newPhoto) ui.settingsAvatarPreview.src = newPhoto;

    showToast("Profile updated successfully", "success");
  } catch (err) {
    console.error("Profile update error:", err);
    showToast("Error updating profile", "error");
  } finally {
    ui.saveAccountBtn.disabled = false;
    ui.saveAccountBtn.textContent = "Save Profile";
  }
}

async function loadUsageStats() {
  if (!state.currentUser) return;
  try {
    const snap = await getDoc(doc(db, "users", state.currentUser.uid));
    if (snap.exists()) {
      const data = snap.data();
      if (ui.statsTotalRequests) ui.statsTotalRequests.textContent = data.questionsAsked || 0;
      if (ui.statsTokensUsed) ui.statsTokensUsed.textContent = `~${(data.questionsAsked || 0) * 150}`; // Estimated tokens
    }
  } catch (err) {
    console.error("Stats load error:", err);
  }
}

function applyFontSize(size) {
  document.documentElement.style.setProperty("--app-font-size", `${size}px`);
  // If we were using raw CSS for font sizes, we'd adjust body/html
  document.body.style.fontSize = `${size}px`;
}

function handleInAppPasswordChange() {
  const modal = document.getElementById("inAppPasswordChangeModal");
  const cancelBtn = document.getElementById("cancelInAppPasswordBtn");
  const confirmBtn = document.getElementById("confirmInAppPasswordBtn");
  
  const currentPassInput = document.getElementById("inAppCurrentPassword");
  const newPassInput = document.getElementById("inAppNewPassword");
  const confirmPassInput = document.getElementById("inAppConfirmPassword");

  if (!modal || !cancelBtn || !confirmBtn) return;

  // Reset fields
  currentPassInput.value = "";
  newPassInput.value = "";
  confirmPassInput.value = "";
  modal.classList.add("show");

  cancelBtn.onclick = () => {
    modal.classList.remove("show");
  };

  confirmBtn.onclick = async () => {
    const currentPassword = currentPassInput.value;
    const newPassword = newPassInput.value;
    const confirmPassword = confirmPassInput.value;

    if (!currentPassword || !newPassword || !confirmPassword) {
      showToast("Please fill in all fields", "error");
      return;
    }
    if (newPassword.length < 6) {
      showToast("New password must be at least 6 characters", "error");
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast("New passwords do not match", "error");
      return;
    }

    try {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Updating...";

      // Re-authenticate
      const credential = EmailAuthProvider.credential(state.currentUser.email, currentPassword);
      await reauthenticateWithCredential(state.currentUser, credential);

      // Update password
      await updatePassword(state.currentUser, newPassword);

      // Log source to Firestore
      await updateDoc(doc(db, "users", state.currentUser.uid), {
        passwordChangeMethod: "in-app",
        passwordChangedAt: serverTimestamp()
      });

      showToast("Password updated successfully", "success");
      modal.classList.remove("show");
    } catch (err) {
      console.error("Password update error:", err);
      if (err.code === "auth/invalid-credential") {
        showToast("Incorrect current password", "error");
      } else if (err.code === "auth/requires-recent-login") {
        showToast("Session expired. Please log out and log back in.", "error");
      } else {
        showToast(err.message, "error");
      }
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Update Password";
    }
  };
}

async function exportUserData() {
  try {
    const userDoc = await getDoc(doc(db, "users", state.currentUser.uid));
    const chatsQuery = query(collection(db, "chats"), where("userId", "==", state.currentUser.uid));
    const chatsSnap = await getDocs(chatsQuery);

    const chats = [];
    for (const d of chatsSnap.docs) {
      const chatData = d.data();
      const msgsSnap = await getDocs(collection(db, "chats", d.id, "messages"));
      chatData.messages = msgsSnap.docs.map(m => m.data());
      chats.push(chatData);
    }

    const exportData = {
      profile: userDoc.data(),
      chats,
      exportedAt: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `studymate_data_export_${state.currentUser.uid}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Data export successful", "success");
  } catch (err) {
    console.error("Export error:", err);
    showToast("Export failed", "error");
  }
}

async function handleDeleteAccount() {
  const step1 = await showConfirm({
    label: "Danger Zone",
    title: "Delete Account Forever?",
    message: "Are you sure you want to permanently delete your StudyMate AI account?\n\nThis action cannot be undone.",
    confirmText: "Continue",
    type: "danger"
  });
  if (!step1) return;

  const isGoogle = state.currentUser.providerData.some(p => p.providerId === 'google.com');

  if (isGoogle) {
    const step2 = await showConfirm({
      label: "Verify Identity",
      title: "Re-authenticate",
      message: "Please sign in with Google again to confirm your identity before deleting your account.",
      confirmText: "Sign in with Google",
      type: "info"
    });
    if (!step2) return;
    try {
      await reauthenticateWithPopup(state.currentUser, new GoogleAuthProvider());
    } catch (err) {
      console.error("Google Reauth Error:", err);
      showToast("Authentication failed: " + err.message, "error");
      return;
    }
    await processAccountDeletion();
  } else {
    // Show password re-auth modal
    const modal = document.getElementById("deleteReauthModal");
    const cancelBtn = document.getElementById("cancelDeleteReauthBtn");
    const confirmBtn = document.getElementById("confirmDeleteReauthBtn");
    const passInput = document.getElementById("deleteReauthPassword");
    
    if (!modal || !cancelBtn || !confirmBtn || !passInput) return;

    passInput.value = "";
    modal.classList.add("show");

    return new Promise((resolve) => {
      cancelBtn.onclick = () => {
        modal.classList.remove("show");
        resolve(false);
      };

      confirmBtn.onclick = async () => {
        const pwd = passInput.value;
        if (!pwd) {
          showToast("Please enter your current password", "error");
          return;
        }

        try {
          confirmBtn.disabled = true;
          confirmBtn.textContent = "Verifying...";
          const credential = EmailAuthProvider.credential(state.currentUser.email, pwd);
          await reauthenticateWithCredential(state.currentUser, credential);
          modal.classList.remove("show");
          await processAccountDeletion();
          resolve(true);
        } catch (err) {
          console.error("Reauth Error:", err);
          if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password") {
            showToast("Incorrect password.", "error");
          } else {
            showToast("Authentication failed: " + err.message, "error");
          }
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Confirm Delete";
        }
      };
    });
  }
}

async function processAccountDeletion() {
  try {
    const userRef = doc(db, "users", state.currentUser.uid);
    const userDoc = await getDoc(userRef);
    if (userDoc.exists()) {
      const data = userDoc.data();
      if (data.passwordChangeMethod === "forgot-password" && data.passwordChangedAt) {
        const changedTime = data.passwordChangedAt.toDate ? data.passwordChangedAt.toDate() : new Date(data.passwordChangedAt);
        const daysSinceChange = (Date.now() - changedTime.getTime()) / (1000 * 3600 * 24);
        if (daysSinceChange < PASSWORD_DELETE_PROTECTION_DAYS) {
          showToast(`Password recently changed. Due to security reasons, your account cannot be deleted right now. Please try again after ${PASSWORD_DELETE_PROTECTION_DAYS} days.`, "error");
          return;
        }
      }
    }

    console.info(`[ACCOUNT] Soft-deleting account for UID: ${state.currentUser.uid}`);
    
    await updateDoc(userRef, {
      deleted: true,
      deletedAt: serverTimestamp(),
      accountStatus: "deleted"
    });

    await state.currentUser.delete();
    console.info(`[ACCOUNT] Successfully deleted Firebase Auth for UID: ${state.currentUser.uid}`);

    await signOut(auth);
    window.location.replace("/login");
  } catch (err) {
    console.error("Delete error:", err);
    showToast("Error during deletion: " + err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Dashboard events
// ---------------------------------------------------------------------------

function bindDashboardEvents() {
  if (ui._dashboardEventsBound) return;
  ui._dashboardEventsBound = true;

  if (ui.newChatBtn) bindSafeListener(ui.newChatBtn, "click", handleNewChat);
  if (ui.logoutBtn) bindSafeListener(ui.logoutBtn, "click", handleLogout);
  bindModeDropdown();
  bindNotesDropdown();

  if (ui.chatForm) {
    bindSafeListener(ui.chatForm, "submit", async (e) => { e.preventDefault(); await handleSendMessage(); });
  }
  if (ui.userInput) {
    bindSafeListener(ui.userInput, "input", () => autoResizeTextarea(ui.userInput));
    bindSafeListener(ui.userInput, "keydown", async (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); await handleSendMessage(); } });
  }
  if (ui.hinglishToggle) {
    bindSafeListener(ui.hinglishToggle, "change", async () => await saveActiveChatSettings());
  }

  if (ui.profileBtn) {
    bindSafeListener(ui.profileBtn, "click", (e) => {
      e.stopPropagation();
      closeModeDropdown();
      closeNotesDropdown();
      if (ui.profileDropdown) ui.profileDropdown.classList.toggle("show");
    });
  }
  if (ui.settingsBtn) bindSafeListener(ui.settingsBtn, "click", () => goToSettings());
  if (ui.editNameBtn) bindSafeListener(ui.editNameBtn, "click", () => openEditNameModal());
  if (ui.cancelBtn) bindSafeListener(ui.cancelBtn, "click", () => closeEditNameModal());
  if (ui.saveNameBtn) bindSafeListener(ui.saveNameBtn, "click", async () => await saveDisplayName());
  if (ui.newNameInput) {
    bindSafeListener(ui.newNameInput, "keydown", async (e) => {
      if (e.key === "Enter") { e.preventDefault(); await saveDisplayName(); }
      if (e.key === "Escape") closeEditNameModal();
    });
  }

  if (ui.chatHistoryList) {
    bindSafeListener(ui.chatHistoryList, "click", async (e) => {
      const o = e.target.closest("[data-open-chat]"), r = e.target.closest("[data-rename-chat]"),
        d = e.target.closest("[data-delete-chat]"), s = e.target.closest("[data-save-rename]"),
        c = e.target.closest("[data-cancel-rename]");
      if (o) return openChat(o.dataset.openChat);
      if (r) return startRename(r.dataset.renameChat);
      if (d) return await deleteChat(d.dataset.deleteChat);
      if (s) return await saveRename(s.dataset.saveRename);
      if (c) return cancelRename();
    });
    bindSafeListener(ui.chatHistoryList, "input", (e) => { if (e.target.matches(".rename-input")) state.renameDraft = e.target.value; });
    bindSafeListener(ui.chatHistoryList, "keydown", async (e) => { if (!e.target.matches(".rename-input")) return; if (e.key === "Enter") { e.preventDefault(); await saveRename(e.target.dataset.chatId); } if (e.key === "Escape") cancelRename(); });
  }

  if (ui.chatMessages) {
    bindSafeListener(ui.chatMessages, "click", async (e) => {
      const cb = e.target.closest("[data-copy-code]");
      const cp = e.target.closest("[data-copy-message]");
      const rg = e.target.closest("[data-regenerate-message]");
      if (cb) return await window.copyCode(cb);
      if (cp) return await copyMessageContent(Number(cp.dataset.copyMessage));
      if (rg) return await regenerateAiMessage(Number(rg.dataset.regenerateMessage));
    });
  }

  if (ui.changelogBtn) {
    bindSafeListener(ui.changelogBtn, "click", () => {
      closeSidebar();
      history.pushState(null, "", "?view=changelog");
      toggleChangelogView(true);
    });
  }

  if (ui.changelogBackBtn) {
    bindSafeListener(ui.changelogBackBtn, "click", () => {
      history.back(); // Triggers popstate which handles the hiding
    });
  }

  if (ui.menuToggleBtn) bindSafeListener(ui.menuToggleBtn, "click", toggleSidebar);
  if (ui.sidebarOverlay) bindSafeListener(ui.sidebarOverlay, "click", closeSidebar);
  if (ui.guestLoginBtn) bindSafeListener(ui.guestLoginBtn, "click", () => window.location.assign("/login"));
  if (ui.guestSignupBtn) bindSafeListener(ui.guestSignupBtn, "click", () => window.location.assign("/signup"));
  if (ui.guestLaterBtn) bindSafeListener(ui.guestLaterBtn, "click", closeGuestLimitModal);
  if (ui.guestLimitModal) {
    bindSafeListener(ui.guestLimitModal, "click", (e) => {
      if (e.target === ui.guestLimitModal) closeGuestLimitModal();
    });
  }

  if (!window._dashboardDocClickBound) {
    window._dashboardDocClickBound = true;
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".profile-wrap") && ui?.profileDropdown?.classList?.contains("show")) {
        ui.profileDropdown.classList.remove("show");
      }
      if (!e.target.closest("#modeDropdown")) closeModeDropdown();
      if (!e.target.closest("#notesDropdown")) closeNotesDropdown();
    });
  }

  if (ui.editNameModal) {
    bindSafeListener(ui.editNameModal, "click", (e) => { if (e.target === ui.editNameModal) closeEditNameModal(); });
  }
}

// ---------------------------------------------------------------------------
// Settings events
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Logout / profile
// ---------------------------------------------------------------------------

async function confirmLogoutAll() {
  const confirmed = await showConfirm({
    label: "Confirm Logout",
    title: "Log out from devices?",
    message: "Are you sure you want to log out of your current session?",
    confirmText: "Log Out",
    type: "danger"
  });
  if (confirmed) await handleLogout();
}

async function handleLogout() {
  if (state.isGuestMode) {
    window.location.replace("/login");
    return;
  }
  try {
    cleanupChatSubscription();
    cleanupDeviceSession();
    if (!state.isGuestMode && state.currentUser?.uid) {
      // Best-effort remote revocation before sign-out
      revokeCurrentSession(state.currentUser.uid).catch(console.error);
    }
    // --- Chat Session Persistence: clear on logout to prevent stale state ---
    persistLastActiveChatId(null, state.currentUser?.uid);
    spaNavigation.clearUserCaches();
    invalidateModelCache();
    history.replaceState(null, "", "/"); // Route cleanup on logout
    await signOut(auth);
    queueFlashToast("Logged out successfully.", "success");
    window.location.replace("/login");
  } catch (err) {
    console.error("Logout error:", err);
    showToast(err.message, "error");
  }
}

function cleanupChatSubscription() {
  if (typeof state.chatsUnsubscribe === "function") { state.chatsUnsubscribe(); state.chatsUnsubscribe = null; }
  if (typeof window.messagesUnsubscribe === "function") { window.messagesUnsubscribe(); window.messagesUnsubscribe = null; }
}

function displayUserProfile(name, email, photo) {
  if (!ui) return;
  const avatarUrl = photo || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}`;
  const shortName = getShortName(name);
  if (ui.userAvatar) { ui.userAvatar.src = avatarUrl; ui.userAvatar.alt = `${name} avatar`; }
  if (ui.dropdownAvatar) { ui.dropdownAvatar.src = avatarUrl; ui.dropdownAvatar.alt = `${name} avatar`; }
  if (ui.userShortName) ui.userShortName.textContent = shortName;
  if (ui.dropdownUserName) ui.dropdownUserName.innerText = name;
  if (ui.dropdownUserEmail) ui.dropdownUserEmail.innerText = email;
}

function renderSettingsAccount(user) {
  ui.settingsUserName.textContent = user.displayName || "User";
  ui.settingsUserEmail.textContent = user.email || "No email found";
}

function openEditNameModal() {
  if (state.isGuestMode) {
    showToast("Please log in to edit your profile.", "info");
    return;
  }
  const currentName = auth.currentUser?.displayName || "User";
  ui.profileDropdown.classList.remove("show");
  ui.newNameInput.value = currentName; ui.editNameModal.classList.add("show");
  requestAnimationFrame(() => { ui.newNameInput.focus(); ui.newNameInput.select(); });
}

function closeEditNameModal() { ui.editNameModal.classList.remove("show"); }

async function saveDisplayName() {
  const newName = ui.newNameInput.value.trim();
  if (!newName) { showToast("Name cannot be empty.", "error"); return; }
  const user = auth.currentUser;
  if (!user) { showToast("No user is currently logged in.", "error"); return; }
  try {
    await updateProfile(user, { displayName: newName });
    await updateDoc(doc(db, "users", user.uid), { name: newName });
    displayUserProfile(newName, user.email || "No email found", user.photoURL || "");
    closeEditNameModal(); showToast("Name updated successfully.", "success");
  } catch (err) { console.error("Failed to update name:", err); showToast("Failed to update name.", "error"); }
}

// ---------------------------------------------------------------------------
// Chat CRUD
// ---------------------------------------------------------------------------

async function handleNewChat() {
  state.currentChatId = null;
  state.preferredChatId = null;
  // --- Chat Session Persistence: clear so refresh shows clean "New Chat" ---
  persistLastActiveChatId(null, state.currentUser?.uid);
  state.editingChatId = null;
  state.renameDraft = "";
  state.editingMessageIndex = null;
  state.messageDraft = "";
  if (state.streamingResponse) stopStreamingResponse();

  const defaultMode = getSavedDefaultMode();
  const defaultHinglish = getSavedHinglishDefault();
  const defaultNotesMode = getSavedDefaultNotesMode();

  setSelectedMode(defaultMode);
  setSelectedNotesMode(defaultNotesMode);
  ui.hinglishToggle.checked = defaultHinglish;

  ui.userInput.value = "";
  autoResizeTextarea(ui.userInput);

  renderHistory();
  renderMessages();

  ui.userInput.focus();
  closeSidebar();
}

async function createNewChatDocument() {
  const userId = getCurrentUserId();
  const defaultMode = getSavedDefaultMode();
  const defaultHinglish = getSavedHinglishDefault();
  const defaultNotesMode = getSavedDefaultNotesMode();

  const docRef = await addDoc(collection(db, "chats"), {
    userId: userId,
    title: "New Chat",
    mode: defaultMode,
    hinglish: defaultHinglish,
    notesMode: defaultNotesMode,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  const newChat = {
    id: docRef.id, userId: userId, title: "New Chat",
    mode: defaultMode, hinglish: defaultHinglish, notesMode: defaultNotesMode,
    messages: [], createdAt: null, updatedAt: null
  };

  state.chats = [newChat, ...state.chats.filter((c) => c.id !== docRef.id)];
  state.currentChatId = docRef.id;
  // --- Chat Session Persistence: persist newly created Firestore-backed chat ---
  if (!state.isGuestMode) {
    persistLastActiveChatId(docRef.id, state.currentUser?.uid);
  }

  loadChats(docRef.id);
  loadMessages(docRef.id);

  return newChat;
}

function createGuestChatDocument() {
  const defaultMode = getSavedDefaultMode();
  const defaultHinglish = getSavedHinglishDefault();
  const defaultNotesMode = getSavedDefaultNotesMode();
  const guestChat = {
    id: `guest-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: "guest",
    title: "New Chat",
    mode: defaultMode,
    hinglish: defaultHinglish,
    notesMode: defaultNotesMode,
    messages: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now()
  };
  state.chats = [guestChat, ...state.chats.filter((c) => c.id !== guestChat.id)];
  state.currentChatId = guestChat.id;
  syncHeaderWithActiveChat();
  renderHistory();
  renderMessages();
  return guestChat;
}

function loadChats(preferredChatId = state.currentChatId) {
  try {
    const userId = getCurrentUserId();
    if (preferredChatId) state.preferredChatId = preferredChatId;
    if (state.chatsUnsubscribe) { syncHeaderWithActiveChat(); renderHistory(); renderMessages(); return; }

    const chatsQuery = query(collection(db, "chats"), where("userId", "==", userId));
    state.chatsUnsubscribe = onSnapshot(chatsQuery, (snapshot) => {
      try {
        const newChats = [];
        const chatMap = new Map(state.chats.map(c => [c.id, c]));

        snapshot.docs.forEach((d) => {
          const data = d.data({ serverTimestamps: "estimate" });
          const existingChat = chatMap.get(d.id);
          const parsed = {
            id: d.id,
            userId: data.userId,
            title: data.title || "New Chat",
            mode: normalizeMode(data.mode),
            hinglish: Boolean(data.hinglish),
            notesMode: data.notesMode || "normal",
            createdAt: data.createdAt || null,
            updatedAt: data.updatedAt || data.createdAt || null
          };

          if (existingChat) {
            // Patch existing chat to preserve messages, streaming state, object reference
            Object.assign(existingChat, parsed);
            newChats.push(existingChat);
          } else {
            // New chat
            parsed.messages = [];
            newChats.push(parsed);
          }
        });

        // Sort by updatedAt descending
        state.chats = newChats.sort((a, b) => getTimestampValue(b.updatedAt) - getTimestampValue(a.updatedAt));

        syncStateWithLatestChats(); syncHeaderWithActiveChat(); renderHistory();
        if (state.currentChatId && state.chats.some(c => c.id === state.currentChatId) && !window.messagesUnsubscribe) {
          loadMessages(state.currentChatId);
        }
        renderMessages();
      } catch (err) {
        console.error("[Render Safety] chats snapshot callback failed:", err);
      }
    }, (error) => {
      console.error(error);
      if (error.code === "permission-denied") {
        showToast("Access denied");
      } else {
        showToast("Something went wrong");
      }
    });
  } catch (error) {
    console.error(error);
    if (error.code === "permission-denied") {
      showToast("Access denied");
    } else {
      showToast("Something went wrong");
    }
  }
}

window.messagesUnsubscribe = null;

function loadMessages(chatId) {
  try {
    const userId = getCurrentUserId();
    if (window.messagesUnsubscribe) {
      window.messagesUnsubscribe();
      window.messagesUnsubscribe = null;
    }

    if (!chatId) return;

    const messagesQuery = query(
      collection(db, "chats", chatId, "messages"),
      orderBy("createdAt", "asc")
    );

    window.messagesUnsubscribe = onSnapshot(messagesQuery, (snapshot) => {
      const activeChat = getChatById(chatId);
      if (!activeChat) return;

      const isFirstLoad = activeChat.messages.length === 0 && snapshot.docs.length > 0;

      activeChat.messages = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data({ serverTimestamps: "estimate" })
      }));

      activeChat.messages.sort((a, b) => {
        const timeA = a.createdAt?.seconds || 0;
        const timeB = b.createdAt?.seconds || 0;
        return timeA - timeB;
      });

      if (state.currentChatId === chatId) {
        renderMessages();
        // If this was the initial load, scroll to bottom
        if (isFirstLoad) {
          setTimeout(() => scrollMessagesToBottom(true), 50);
        }
      }
    }, (error) => {
      console.error(error);
      if (error.code === "permission-denied") {
        showToast("Access denied");
      } else {
        showToast("Something went wrong");
      }
    });
  } catch (error) {
    console.error(error);
    if (error.code === "permission-denied") {
      showToast("Access denied");
    } else {
      showToast("Something went wrong");
    }
  }
}

function renderHistory() {
  if (!state.chats.length) { ui.chatHistoryList.innerHTML = `<div class="history-empty">Start a new conversation &#128640;</div>`; return; }
  const ordered = [...state.chats].sort((a, b) => getTimestampValue(b.updatedAt) - getTimestampValue(a.updatedAt));
  ui.chatHistoryList.innerHTML = ordered.map((chat) => {
    const isActive = chat.id === state.currentChatId ? "active" : "";
    if (chat.id === state.editingChatId) {
      return `<article class="history-card ${isActive}"><div class="rename-form"><input class="rename-input" data-chat-id="${chat.id}" type="text" maxlength="50" value="${escapeAttribute(state.renameDraft)}" placeholder="Rename chat" /><div class="rename-actions"><button class="rename-btn" data-save-rename="${chat.id}" type="button">Save</button><button class="rename-btn" data-cancel-rename type="button">Cancel</button></div></div></article>`;
    }
    return `<article class="history-card ${isActive}"><button class="history-open" data-open-chat="${chat.id}" type="button"><span class="history-title">${escapeHtml(chat.title)}</span><span class="history-meta">${MODE_LABELS[chat.mode] || MODE_LABELS.general}${chat.hinglish ? " | Hinglish" : ""}</span><span class="history-meta">${formatSidebarDate(chat.updatedAt)}</span></button><div class="history-actions"><button class="history-action" data-rename-chat="${chat.id}" type="button">Rename</button><button class="history-action danger" data-delete-chat="${chat.id}" type="button">Delete</button></div></article>`;
  }).join("");
  focusRenameInput();
}

function syncStateWithLatestChats() {
  if (state.preferredChatId && state.chats.some((c) => c.id === state.preferredChatId)) {
    state.currentChatId = state.preferredChatId;
    state.preferredChatId = null;
  } else if (state.currentChatId && state.chats.some((c) => c.id === state.currentChatId)) {
    // Keep current
  } else {
    // Only nullify if we actually have chats loaded, otherwise it might be a temporary empty cache state
    if (state.chats.length > 0 || state.preferredChatId === null) {
      if (state.preferredChatId && state.chats.length > 0) {
        console.warn("[Security] Denied route access: Chat does not exist or belongs to another user. Falling back safely.");
      }
      state.currentChatId = null;
      state.preferredChatId = null;
    }
  }

  // --- Chat Session Persistence: keep localStorage in sync after Firestore snapshot ---
  if (!state.isGuestMode) persistLastActiveChatId(state.currentChatId, state.currentUser?.uid);
  if (!state.chats.some((c) => c.id === state.editingChatId)) { state.editingChatId = null; state.renameDraft = ""; }
  const activeChat = getCurrentChat();
  if (!activeChat || state.editingMessageIndex == null) { state.editingMessageIndex = null; state.messageDraft = ""; }
  else if (!activeChat.messages[state.editingMessageIndex] || activeChat.messages[state.editingMessageIndex].role !== "user") { state.editingMessageIndex = null; state.messageDraft = ""; }
  if (state.streamingResponse && state.streamingResponse.chatId !== activeChat?.id) stopStreamingResponse();
}

// ---------------------------------------------------------------------------
// Messages rendering
// ---------------------------------------------------------------------------

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";
  return "Working late?";
}

function getHelperText() {
  const texts = [
    "How can I help you today?",
    "Ask anything.",
    "Need help with something?",
    "What would you like to learn?"
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function renderMessages() {
  try {
    const activeChat = getCurrentChat();
    const showTyping = Boolean(state.showTypingIndicator);
    const isStreaming = state.streamingResponse && state.streamingResponse.chatId === activeChat?.id;

    if (!activeChat || (activeChat.messages.length === 0 && !showTyping && !isStreaming)) {
      const greeting = getGreeting();
      const helperText = getHelperText();
      ui.chatMessages.innerHTML = `
        <div class="greeting-container fade-in-text">
          <h2 class="greeting-title">${greeting}</h2>
          <p class="greeting-subtitle">${helperText}</p>
        </div>
      `;
      ui.chatForm.style.display = "flex";
      return;
    }
    const messageMarkup = activeChat.messages.map((message, index) => {
      const roleLabel = message.role === "user" ? "You" : "StudyMate AI";
      // --- RAG Integration: Show "Live" badge on RAG-enhanced AI messages ---
      const ragBadge = (message.role === "ai" && message.rag_enhanced) ? `<span class="rag-badge">Live</span>` : "";
      const contentMarkup = `<div class="message-content" data-message-content="${index}">${formatMessage(message.content, message.role, message.intent, message.doubt)}</div>`;
      const sourcesMarkup = renderMessageSources(message);
      const actionMarkup = renderMessageActions(activeChat.messages, message, index);
      return `<div class="message-row ${message.role}"><div class="message-bubble"><div class="message-meta"><strong>${roleLabel}</strong>${ragBadge}</div>${contentMarkup}${sourcesMarkup}${actionMarkup}</div></div>`;
    }).join("");

    let assistantBubbleMarkup = "";
    if (isStreaming || showTyping) {
      const text = isStreaming ? state.streamingResponse.visibleText : "";
      // --- RAG Integration: Show search indicator when waiting for live info ---
      const lastUserMsg = getLatestUserMessageFromPayload(activeChat.messages);
      const isRagQuery = REALTIME_QUERY_REGEX.test(lastUserMsg || "");
      const ragIndicator = (!text && showTyping && isRagQuery)
        ? `<div class="rag-search-indicator"><span class="rag-pulse"></span><span class="rag-label">Searching latest information...</span></div>`
        : "";
      const content = text
        ? formatMessage(text, "ai")
        : `${ragIndicator}<div class="thinking-dots"><span></span><span></span><span></span></div>`;

      assistantBubbleMarkup = `
      <div class="message-row ai">
        <div class="message-bubble">
          <div class="message-meta"><strong>StudyMate AI</strong></div>
          <div class="message-content" data-stream-content>${content}</div>
        </div>
      </div>
    `.trim();
    }

    ui.chatMessages.innerHTML = `${messageMarkup}${assistantBubbleMarkup}`;
    renderMath();
    renderMermaidDiagrams();
    focusMessageEditor();
  } catch (err) {
    console.error("[Render Safety] renderMessages failed:", err);
  }
}

/**
 * renderMath()
 * Safely parses and renders LaTeX mathematical expressions within the chat using KaTeX.
 */
function renderMath() {
  if (typeof renderMathInElement === "undefined" || !ui.chatMessages) return;
  try {
    renderMathInElement(ui.chatMessages, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false }
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
      throwOnError: false
    });
  } catch (err) {
    console.error("KaTeX math render error:", err);
  }
}

function openChat(chatId) {
  if (state.streamingResponse && state.streamingResponse.chatId !== chatId) stopStreamingResponse();
  state.currentChatId = chatId; state.editingChatId = null; state.renameDraft = "";
  state.editingMessageIndex = null; state.messageDraft = "";
  // --- Chat Session Persistence: persist on every explicit chat switch ---
  if (!state.isGuestMode) {
    persistLastActiveChatId(chatId, state.currentUser?.uid);
  }

  if (!state.isGuestMode) {
    loadMessages(chatId);
  } else {
    syncHeaderWithActiveChat();
    renderHistory();
    renderMessages();
    // Force scroll to bottom on initial load
    setTimeout(() => scrollMessagesToBottom(true), 100);
  }

  closeSidebar();
}

// ---------------------------------------------------------------------------
// Send message → backend proxy
// ---------------------------------------------------------------------------

async function handleSendMessage() {
  try {
    if (state.isSending) return;
    const content = ui.userInput.value.trim();
    if (!content) return;
    if (state.isGuestMode && isGuestUsageLimitReached()) {
      showGuestLimitModal();
      showToast("Guest question limit reached. Please log in to continue.", "info");
      return;
    }

    if (!state.currentChatId) {
      if (state.isGuestMode) createGuestChatDocument();
      else await createNewChatDocument();
    }
    const activeChat = getCurrentChat();
    if (!activeChat) { showToast("Unable to open a chat session.", "error"); return; }

    ui.userInput.value = ""; autoResizeTextarea(ui.userInput);

    if (state.isGuestMode) {
      incrementGuestQuestionUsage();
      activeChat.messages.push(createGuestMessage("user", content));
      activeChat.updatedAt = Timestamp.now();
      renderHistory();
      renderMessages();
    } else {
      await addDoc(collection(db, "chats", activeChat.id, "messages"), {
        role: "user",
        content: content,
        createdAt: serverTimestamp()
      });
      await updateDoc(doc(db, "chats", activeChat.id), { updatedAt: serverTimestamp() });
    }

    await generateAssistantReply({ chat: activeChat, userContent: content, titleSource: content });
  } catch (error) {
    console.error(error);
    if (error.code === "permission-denied") {
      showToast("Access denied");
    } else {
      showToast("Something went wrong");
    }
  }
}

async function fetchWithRetry(fn, retries = 2) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0) return fetchWithRetry(fn, retries - 1);
    throw err;
  }
}

async function fetchAIResponse(messages, mode, hinglishEnabled, notesMode) {
  const requestPayload = {
    messages,
    mode,
    model_choice: state.userSettings.aiModel || "auto",
    hinglish: hinglishEnabled,
    notesMode: notesMode || "normal",
    userId: state.currentUser?.uid || "guest",
    currentQuestion: state.currentQuestion,
    stream: true, // Enable Real-Time Streaming
    autoQuestion: state.userSettings.autoQuestion ?? true,
    userProfile: {
      preferred_style: state.userSettings.aiStyle || "detailed",
      preferred_tone: state.userSettings.aiTone || "professional",
      model_choice: state.userSettings.aiModel || "auto"
    },
    userContext: {
      email: state.currentUser?.email || "",
      name: state.currentUser?.displayName || "",
      provider: state.currentUser?.providerData?.[0]?.providerId || ""
    },
    userMemory: state.userMemory
  };

  try {
    const controller = new AbortController();
    const headers = { "Content-Type": "application/json" };
    if (auth.currentUser) {
      try {
        const token = await auth.currentUser.getIdToken();
        headers["Authorization"] = `Bearer ${token}`;
      } catch (tokenErr) {
        console.error("Failed to retrieve ID token:", tokenErr);
      }
    }
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "AI service is currently unavailable.");
    }

    // Check if it's a stream
    const contentType = response.headers.get("Content-Type");
    if (contentType && contentType.includes("text/event-stream")) {
      return { body: response.body, isStream: true, controller };
    }

    // Fallback for non-streaming response
    const data = await response.json();
    return {
      text: data.reply || data.text,
      sources: data.sources || [],
      intent: data.intent || "GENERAL",
      doubt: data.doubt || false,
      metadata: data
    };
  } catch (err) {
    console.error("Backend request failed:", err);
    throw err;
  }
}

async function saveActiveChatSettings() {
  const activeChat = getCurrentChat();
  if (!activeChat) return;
  activeChat.mode = getSelectedMode();
  activeChat.hinglish = ui.hinglishToggle.checked;
  activeChat.notesMode = getSelectedNotesMode();
  activeChat.updatedAt = Timestamp.now();
  renderHistory();
  if (state.isGuestMode) return;
  try { await updateDoc(doc(db, "chats", activeChat.id), { mode: activeChat.mode, hinglish: activeChat.hinglish, notesMode: activeChat.notesMode, updatedAt: serverTimestamp() }); }
  catch (err) { console.error("Save mode error:", err); showToast(err.message, "error"); }
}

async function generateAssistantReply({ chat, apiMessages = null, userContent = null, titleSource = "", successMessage = "" }) {
  if (!chat || state.isSending) return;
  state.isSending = true;
  state.showTypingIndicator = true;
  state.editingMessageIndex = null;
  state.messageDraft = "";
  setComposerLoading(true);

  chat.mode = getSelectedMode();
  chat.hinglish = ui.hinglishToggle.checked;
  chat.notesMode = getSelectedNotesMode();
  renderHistory();
  renderMessages();
  scrollMessagesToBottom(true); // Initial scroll

  let finalApiMessages = apiMessages || [...chat.messages].slice(-6);
  if (userContent && !finalApiMessages.some(m => m.content === userContent && m.role === "user")) {
    finalApiMessages.push({ role: "user", content: userContent });
  }

  try {
    const aiResult = await fetchAIResponse(finalApiMessages, chat.mode, chat.hinglish, chat.notesMode);

    let finalContent = "";
    let finalMetadata = null;

    if (aiResult.isStream) {
      // HANDLE REAL STREAMING
      const streamData = await streamAssistantMessage(chat.id, aiResult.body, aiResult.controller);
      finalContent = streamData.text;
      finalMetadata = streamData.metadata;
    } else {
      // HANDLE LEGACY/SYNC RESPONSE
      state.showTypingIndicator = false;
      finalContent = aiResult.text;
      finalMetadata = aiResult.metadata;
      await streamAssistantMessage(chat.id, finalContent); // Fallback to simulated stream for sync responses
    }

    const aiSources = normalizeSources(finalMetadata?.sources || aiResult.sources);
    const aiIntent = finalMetadata?.intent || aiResult.intent || "GENERAL";
    const aiDoubt = finalMetadata?.doubt || aiResult.doubt || false;
    const aiRagEnhanced = finalMetadata?.rag_enhanced || false; // RAG Integration

    if (finalMetadata?.ui) {
      if (finalMetadata.ui.syncState?.currentQuestion) {
        state.currentQuestion = finalMetadata.ui.syncState.currentQuestion;
      }
      if (finalMetadata.ui.memoryUpdates && finalMetadata.ui.memoryUpdates.length > 0) {
        saveUserMemories(finalMetadata.ui.memoryUpdates);
      }
    }

    if (finalMetadata?.success === false || aiResult?.metadata?.success === false) {
      showToast("AI is temporarily busy. Showing fallback response.", "error");
    }

    if (state.isGuestMode) {
      const msg = createGuestMessage("ai", finalContent, aiSources);
      msg.intent = aiIntent;
      msg.doubt = aiDoubt;
      msg.rag_enhanced = aiRagEnhanced; // RAG Integration
      chat.messages.push(msg);
      chat.updatedAt = Timestamp.now();
      if (chat.title === "New Chat" && titleSource && finalApiMessages.filter((m) => m.role === "ai").length === 0) {
        chat.title = generateChatTitle(titleSource);
      }
    } else {
      await addDoc(collection(db, "chats", chat.id, "messages"), {
        role: "ai",
        content: finalContent,
        sources: aiSources,
        intent: aiIntent,
        doubt: aiDoubt,
        rag_enhanced: aiRagEnhanced, // RAG Integration
        createdAt: serverTimestamp()
      });

      if (chat.title === "New Chat" && titleSource && finalApiMessages.filter((m) => m.role === "ai").length === 0) {
        const newTitle = generateChatTitle(titleSource);
        await updateDoc(doc(db, "chats", chat.id), { title: newTitle, updatedAt: serverTimestamp() });
      } else {
        await updateDoc(doc(db, "chats", chat.id), { updatedAt: serverTimestamp() });
      }
    }

    if (!state.isGuestMode) await incrementStudyTracker();
    if (successMessage) showToast(successMessage, "success");

  } catch (err) {
    console.error("Reply error:", err);
    state.showTypingIndicator = false;
    showToast(err.message || "Failed to get AI response", "error");
  } finally {
    state.isSending = false;
    setComposerLoading(false);
    renderHistory();
    renderMessages();
  }
}

// ---------------------------------------------------------------------------
// Message editing / actions
// ---------------------------------------------------------------------------

// Edit functions removed to enforce strict append-only rules.

async function regenerateAiMessage(messageIndex) {
  try {
    if (state.isGuestMode && isGuestUsageLimitReached()) {
      showGuestLimitModal();
      showToast("Guest question limit reached. Please log in to continue.", "info");
      return;
    }

    const activeChat = getCurrentChat();
    if (!activeChat || state.isSending || !isLatestAiMessage(activeChat.messages, messageIndex)) return;
    const previousUserIndex = findPreviousUserMessageIndex(activeChat.messages, messageIndex);
    if (previousUserIndex === -1) { showToast("No user message found to regenerate from.", "error"); return; }

    const baseMessages = activeChat.messages.slice(0, messageIndex);
    if (state.isGuestMode) incrementGuestQuestionUsage();

    await generateAssistantReply({ chat: activeChat, apiMessages: baseMessages, successMessage: "Response regenerated." });
  } catch (error) {
    console.error(error);
    if (error.code === "permission-denied") {
      showToast("Access denied");
    } else {
      showToast("Something went wrong");
    }
  }
}

async function copyMessageContent(messageIndex) {
  const activeChat = getCurrentChat();
  const targetMessage = activeChat?.messages?.[messageIndex];
  if (!targetMessage) return;
  try { await navigator.clipboard.writeText(targetMessage.content); showToast("Copied!", "success"); }
  catch (err) { console.error("Copy message error:", err); showToast("Unable to copy right now.", "error"); }
}

async function streamAssistantMessage(chatId, source, controller = null) {
  stopStreamingResponse();
  state.streamingResponse = { chatId, visibleText: "", isCancelled: false };

  if (typeof source === "string") {
    // Legacy simulated streaming
    const words = source.split(" ");
    let current = "";
    try {
      for (let i = 0; i < words.length; i++) {
        if (!state.streamingResponse || state.streamingResponse.isCancelled) return;
        current += (i === 0 ? words[i] : ` ${words[i]}`);
        state.streamingResponse.visibleText = current;
        updateStreamUI(current);
        await delay(STREAM_WORD_DELAY_MS);
      }
    } catch (err) {
      console.error("[Render Safety] streamAssistantMessage legacy loop failed:", err);
    }
    stopStreamingResponse();
    return { text: source };
  }

  // Real Multi-Model Streaming
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let accumulatedText = "";
  let metadata = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (state.streamingResponse?.isCancelled) {
        controller?.abort();
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine.startsWith("data: ")) continue;
        const dataStr = cleanLine.slice(6);
        if (dataStr === "[DONE]") break;

        try {
          const data = JSON.parse(dataStr);
          if (data.content) {
            if (state.showTypingIndicator) state.showTypingIndicator = false;
            accumulatedText += data.content;
            state.streamingResponse.visibleText = accumulatedText;
            updateStreamUI(accumulatedText);
            // Auto-scroll removed during streaming loop as per strict request
          } else if (data.metadata) {
            metadata = data.metadata;
          }
        } catch (e) { }
      }
    }
  } catch (err) {
    console.error("[Render Safety] streamAssistantMessage real streaming failed:", err);
  } finally {
    stopStreamingResponse();
    // Handle graceful completion if stream was empty or broken
    if (!accumulatedText || accumulatedText.length < 10) {
      accumulatedText = (accumulatedText || "") + "\n\n" + generateSafeFallbackReply();
    }
    renderMessages();
    renderMermaidDiagrams();
  }

  return { text: accumulatedText, metadata };
}

function stopStreamingResponse() {
  if (state.streamingResponse) state.streamingResponse.isCancelled = true;
  state.streamingResponse = null;
}

function renderMessageActions(messages, message, messageIndex) {
  if (message.role === "user") return "";
  const regenerateButton = isLatestAiMessage(messages, messageIndex) ? `<button class="message-action-btn" data-regenerate-message="${messageIndex}" type="button" aria-label="Regenerate response" title="Regenerate">${getMessageActionIcon("regenerate")}<span class="sr-only">Regenerate</span></button>` : "";
  return `<div class="message-actions"><button class="message-action-btn" data-copy-message="${messageIndex}" type="button" aria-label="Copy response" title="Copy">${getMessageActionIcon("copy")}<span class="sr-only">Copy</span></button>${regenerateButton}</div>`;
}

function isLatestAiMessage(messages, messageIndex) { for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === "ai") return i === messageIndex; } return false; }
function findPreviousUserMessageIndex(messages, messageIndex) { for (let i = messageIndex - 1; i >= 0; i--) { if (messages[i].role === "user") return i; } return -1; }
function findFirstUserMessageIndex(messages) { return messages.findIndex((m) => m.role === "user"); }

function getMessageActionIcon(type) {
  if (type === "edit") return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4.5-1 9-9-3.5-3.5-9 9L4 20zM13.5 5.5l3.5 3.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg>`;
  if (type === "copy") return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/></svg>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5.5M20 4v7h-7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg>`;
}

// ---------------------------------------------------------------------------
// Chat rename / delete
// ---------------------------------------------------------------------------

function startRename(chatId) { const chat = getChatById(chatId); if (!chat) return; state.editingChatId = chatId; state.renameDraft = chat.title; renderHistory(); }
function cancelRename() { state.editingChatId = null; state.renameDraft = ""; renderHistory(); }

async function saveRename(chatId) {
  const nextTitle = state.renameDraft.trim();
  if (!nextTitle) { showToast("Chat title cannot be empty.", "error"); return; }
  const chat = getChatById(chatId); if (!chat) return;
  chat.title = nextTitle; chat.updatedAt = Timestamp.now();
  if (state.isGuestMode) {
    state.editingChatId = null;
    state.renameDraft = "";
    renderHistory();
    renderMessages();
    return;
  }
  try { await updateDoc(doc(db, "chats", chatId), { title: chat.title, updatedAt: chat.updatedAt }); state.editingChatId = null; state.renameDraft = ""; renderHistory(); renderMessages(); }
  catch (err) { console.error("Rename error:", err); showToast(err.message, "error"); }
}

async function deleteChat(chatId) {
  const chat = getChatById(chatId); if (!chat) return;
  const confirmed = await showConfirm({ label: "Delete Chat", title: `Delete "${chat.title}"?`, message: "This chat will be removed permanently from your history.", confirmText: "Delete", type: "danger" });
  if (!confirmed) return;
  if (state.isGuestMode) {
    state.chats = state.chats.filter((c) => c.id !== chatId);
    if (state.currentChatId === chatId) state.currentChatId = state.chats[0]?.id || null;
    state.editingChatId = null;
    state.renameDraft = "";
    syncHeaderWithActiveChat();
    renderHistory();
    renderMessages();
    showToast("Chat deleted.", "success");
    return;
  }
  try {
    await deleteDoc(doc(db, "chats", chatId));
    if (state.currentChatId === chatId) state.currentChatId = null;
    // --- Chat Session Persistence: update after active chat deletion ---
    persistLastActiveChatId(state.currentChatId, state.currentUser?.uid);
    state.editingChatId = null;
    state.renameDraft = "";
    showToast("Chat deleted.", "success");
  } catch (err) {
    console.error("Delete chat error:", err);
    showToast(err.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Header sync / composer
// ---------------------------------------------------------------------------

function syncHeaderWithActiveChat() {
  try {
    const activeChat = getCurrentChat();
    if (!activeChat) {
      setSelectedMode(getSavedDefaultMode());
      setSelectedNotesMode(getSavedDefaultNotesMode());
      ui.hinglishToggle.checked = getSavedHinglishDefault();
      return;
    }
    const currentMode = normalizeMode(activeChat.mode);
    saveDefaultMode(currentMode);
    setSelectedMode(currentMode);
    setSelectedNotesMode(activeChat.notesMode || "normal");
    ui.hinglishToggle.checked = Boolean(activeChat.hinglish);
  } catch (err) {
    console.error("[Render Safety] syncHeaderWithActiveChat failed:", err);
  }
}

function setComposerLoading(isLoading) {
  ui.sendBtn.disabled = isLoading;
  ui.userInput.disabled = isLoading;
}
function getCurrentChat() { return state.chats.find((c) => c.id === state.currentChatId) || null; }
function getChatById(chatId) { return state.chats.find((c) => c.id === chatId) || null; }

function generateChatTitle(message) {
  const cleaned = message.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  const slice = words.slice(0, 5);
  if (slice.length === 0) return "New Chat";
  if (slice.length < 3) return words.slice(0, Math.min(3, words.length)).join(" ");
  return slice.join(" ");
}

function getShortName(name) { const t = String(name || "User").trim(); return t ? t.split(/\s+/)[0] : "User"; }

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const body = document.body;

  if (sidebar) sidebar.classList.toggle("open");
  if (overlay) overlay.classList.toggle("active");
  if (body) body.classList.toggle("sidebar-open");
}

function closeSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const body = document.body;

  if (sidebar) sidebar.classList.remove("open");
  if (overlay) overlay.classList.remove("active");
  if (body) body.classList.remove("sidebar-open");
}

function focusRenameInput() {
  if (!state.editingChatId) return;
  const renameInput = ui.chatHistoryList.querySelector(".rename-input");
  if (!renameInput) return;
  requestAnimationFrame(() => { renameInput.focus(); renameInput.select(); });
}

function focusMessageEditor() {
  if (state.editingMessageIndex == null) return;
  const messageEditor = ui.chatMessages.querySelector("[data-message-edit-input]");
  if (!messageEditor) return;
  requestAnimationFrame(() => { autoResizeTextarea(messageEditor); messageEditor.focus(); messageEditor.setSelectionRange(messageEditor.value.length, messageEditor.value.length); });
}

function autoResizeTextarea(textarea) { textarea.style.height = "auto"; textarea.style.height = `${textarea.scrollHeight}px`; }

// ---------------------------------------------------------------------------
// Mode dropdown
// ---------------------------------------------------------------------------

function bindModeDropdown() {
  if (ui.selectedMode) {
    bindSafeListener(ui.selectedMode, "click", (e) => {
      e.stopPropagation();
      if (ui.profileDropdown) ui.profileDropdown.classList.remove("show");
      closeNotesDropdown();
      if (ui.modeDropdown) {
        ui.modeDropdown.classList.toggle("open");
        ui.selectedMode.setAttribute("aria-expanded", String(ui.modeDropdown.classList.contains("open")));
      }
    });
  }
  if (ui.dropdownOptions) {
    bindSafeListener(ui.dropdownOptions, "click", async (e) => {
      const option = e.target.closest(".option");
      if (!option) return;
      setSelectedMode(option.dataset.value || option.textContent.trim());
      closeModeDropdown();
      await saveActiveChatSettings();
    });
  }
}

function setSelectedMode(mode) {
  const normalized = normalizeMode(mode);
  if (ui.selectedMode) {
    ui.selectedMode.textContent = MODE_LABELS[normalized];
    ui.selectedMode.dataset.value = normalized;
  }
  if (ui.dropdownOptions) {
    ui.dropdownOptions.querySelectorAll(".option").forEach((o) => o.classList.toggle("active", o.dataset.value === normalized));
  }
}

function getSelectedMode() { return normalizeMode(ui?.selectedMode?.dataset?.value || ui?.selectedMode?.textContent); }
function closeModeDropdown() {
  if (ui?.modeDropdown) ui.modeDropdown.classList.remove("open");
  if (ui?.selectedMode) ui.selectedMode.setAttribute("aria-expanded", "false");
}

// ---------------------------------------------------------------------------
// Notes mode dropdown
// ---------------------------------------------------------------------------

function bindNotesDropdown() {
  if (ui.notesSelected) {
    bindSafeListener(ui.notesSelected, "click", (e) => {
      e.stopPropagation();
      if (ui.profileDropdown) ui.profileDropdown.classList.remove("show");
      closeModeDropdown();
      if (ui.notesDropdown) {
        ui.notesDropdown.classList.toggle("open");
        ui.notesSelected.setAttribute("aria-expanded", String(ui.notesDropdown.classList.contains("open")));
      }
    });
  }
  if (ui.notesDropdownOptions) {
    bindSafeListener(ui.notesDropdownOptions, "click", async (e) => {
      const option = e.target.closest(".option");
      if (!option) return;
      setSelectedNotesMode(option.dataset.value || "normal");
      closeNotesDropdown();
      await saveActiveChatSettings();
    });
  }
}

function setSelectedNotesMode(mode) {
  const normalized = normalizeNotesMode(mode);
  const labels = { normal: "Normal", bullet: "Bullet Notes", revision: "Revision Notes", flashcards: "Flashcards" };
  if (ui.notesSelected) {
    ui.notesSelected.textContent = labels[normalized] || "Normal";
    ui.notesSelected.dataset.value = normalized;
  }
  if (ui.notesDropdownOptions) {
    ui.notesDropdownOptions.querySelectorAll(".option").forEach((o) => o.classList.toggle("active", o.dataset.value === normalized));
  }
}

function getSelectedNotesMode() { return normalizeNotesMode(ui?.notesSelected?.dataset?.value || "normal"); }
function closeNotesDropdown() {
  if (ui?.notesDropdown) ui.notesDropdown.classList.remove("open");
  if (ui?.notesSelected) ui.notesSelected.setAttribute("aria-expanded", "false");
}

// ---------------------------------------------------------------------------
// Navigation / settings
// ---------------------------------------------------------------------------

function goToSettings() {
  if (spaNavigation) {
    spaNavigation.navigateTo("/settings");
  } else {
    window.location.href = "/settings";
  }
}
window.goToSettings = goToSettings;

// ---------------------------------------------------------------------------
// Theme system (4 themes)
// ---------------------------------------------------------------------------

function applySavedTheme() {
  const savedTheme = getSavedTheme();
  document.body.classList.remove("light", "blue", "purple");
  if (savedTheme !== "dark") document.body.classList.add(savedTheme);
}

function setTheme(theme) {
  const normalized = AVAILABLE_THEMES.includes(theme) ? theme : "dark";
  document.body.classList.remove("light", "blue", "purple");
  if (normalized !== "dark") document.body.classList.add(normalized);
  localStorage.setItem(STORAGE_KEYS.theme, normalized);
}

function getSavedTheme() {
  const saved = localStorage.getItem(STORAGE_KEYS.theme);
  return AVAILABLE_THEMES.includes(saved) ? saved : "dark";
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function saveDefaultMode(mode) { localStorage.setItem(STORAGE_KEYS.defaultMode, normalizeMode(mode)); }
function getSavedDefaultMode() { return normalizeMode(localStorage.getItem(STORAGE_KEYS.defaultMode)); }
function saveHinglishDefault(isEnabled) { localStorage.setItem(STORAGE_KEYS.hinglishDefault, String(Boolean(isEnabled))); }
function getSavedHinglishDefault() { return localStorage.getItem(STORAGE_KEYS.hinglishDefault) === "true"; }
function saveDefaultNotesMode(mode) { localStorage.setItem(STORAGE_KEYS.defaultNotesMode, normalizeNotesMode(mode)); }
function getSavedDefaultNotesMode() { return normalizeNotesMode(localStorage.getItem(STORAGE_KEYS.defaultNotesMode)); }
function normalizeMode(mode) {
  const m = String(mode || "").toLowerCase();
  return MODES.includes(m) ? m : "general";
}
function normalizeNotesMode(mode) { return AVAILABLE_NOTES_MODES.includes(mode) ? mode : "normal"; }

// ---------------------------------------------------------------------------
// Chat Session Persistence (localStorage-backed, UID-scoped)
// ---------------------------------------------------------------------------
// Persists the active chatId so that page refresh / tab reopen restores the
// last conversation instead of showing an empty "New Chat" state.
// The key is scoped per Firebase UID to prevent cross-user collisions.
// ---------------------------------------------------------------------------

/**
 * Persist the active chat ID to localStorage for session restoration.
 * Only persists Firestore-backed chats (never guest/temp chats).
 * Includes a defensive guard to skip redundant writes.
 */
function persistLastActiveChatId(chatId, userId) {
  if (!userId) return; // No-op for guest / unauthenticated
  const key = `${STORAGE_KEYS.lastActiveChatId}:${userId}`;
  try {
    if (chatId) {
      // Guard: skip write if the value hasn't changed
      if (localStorage.getItem(key) === chatId) return;
      localStorage.setItem(key, chatId);
    } else {
      localStorage.removeItem(key);
    }
  } catch (_) {
    // localStorage may be full or blocked — fail silently
  }
}

function getPersistedLastActiveChatId(userId) {
  if (!userId) return null;
  const key = `${STORAGE_KEYS.lastActiveChatId}:${userId}`;
  try {
    return localStorage.getItem(key) || null;
  } catch (_) {
    return null; // Fail gracefully — same as "no persisted chat"
  }
}

// ---------------------------------------------------------------------------
// URL Routing Helpers (History API) & Security Validation
// ---------------------------------------------------------------------------


let isTransitioningView = false;
let savedChatScrollTop = 0;

function toggleChangelogView(show) {
  if (!ui.changelogView) return;
  if (show) {
    if (ui.chatMessages) savedChatScrollTop = ui.chatMessages.scrollTop;
    ui.changelogView.classList.remove("hidden");
    if (ui.changelogContent.children.length === 0) renderChangelog();
  } else {
    ui.changelogView.classList.add("hidden");
    if (ui.chatMessages) ui.chatMessages.scrollTop = savedChatScrollTop;
  }
}

async function renderChangelog() {
  if (!ui.changelogContent) return;
  ui.changelogContent.innerHTML = `<div style="text-align:center; padding: 40px; color: var(--text-soft)">Loading updates...</div>`;

  let releases = [];

  try {
    // 1. Try fetching from Firestore
    const q = query(collection(db, "changelogs"), where("published", "==", true), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    if (!snap.empty) {
      releases = snap.docs.map(doc => {
        const data = doc.data();
        let formattedDate = "Recently";
        try {
          if (data.createdAt && typeof data.createdAt.toMillis === 'function') {
            formattedDate = new Date(data.createdAt.toMillis()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          } else if (data.createdAt instanceof Date) {
            formattedDate = data.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          } else if (typeof data.createdAt === 'string') {
            formattedDate = new Date(data.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          } else if (data.createdAt?.seconds) {
            formattedDate = new Date(data.createdAt.seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          }
        } catch (e) {
          console.warn("Date formatting error:", e);
        }

        return {
          version: data.version || "Update",
          title: data.title || "",
          date: formattedDate,
          type: data.releaseType || "patch",
          content: data.content || "",
          tags: data.tags || []
        };
      });
    }
  } catch (err) {
    console.warn("Firestore changelog fetch failed. Falling back to JSON.", err);
  }

  // 2. Fallback to local JSON if Firestore is empty or fails
  if (releases.length === 0) {
    try {
      const res = await fetch("/config/changelog.json?t=" + Date.now());
      if (!res.ok) throw new Error("Failed to load changelog.json");
      const data = await res.json();

      let rawReleases = Array.isArray(data.releases) ? data.releases : [];
      // Safe sort
      rawReleases.sort((a, b) => {
        const dA = new Date(a.date).getTime();
        const dB = new Date(b.date).getTime();
        return (isNaN(dB) ? 0 : dB) - (isNaN(dA) ? 0 : dA);
      });

      const seenVersions = new Set();
      releases = rawReleases.filter(r => {
        if (!r.version) return false;
        if (seenVersions.has(r.version)) return false;
        seenVersions.add(r.version);
        return true;
      }).map(r => {
        const contentStr = `## Added\n${(r.sections?.added || []).map(i => "- " + i).join("\n")}\n\n## Improved\n${(r.sections?.improved || []).map(i => "- " + i).join("\n")}\n\n## Fixed\n${(r.sections?.fixed || []).map(i => "- " + i).join("\n")}`;
        return {
          version: r.version,
          title: r.title || "Update",
          date: r.date || "Recently",
          type: r.type || "patch",
          content: contentStr,
          tags: ["legacy"]
        };
      });
    } catch (err) {
      console.error("JSON Fallback failed:", err);
      ui.changelogContent.innerHTML = `
        <div style="text-align:center; padding: 40px; color: var(--danger-color)">
          <p style="margin-bottom: 1rem;">Unable to load changelog at this time.</p>
          <button class="ghost-btn" onclick="renderChangelog()">Retry</button>
        </div>`;
      return;
    }
  }

  if (releases.length === 0) {
    ui.changelogContent.innerHTML = `<div style="text-align:center; padding: 40px; color: var(--text-soft)">No updates found.</div>`;
    return;
  }

  ui.changelogContent.innerHTML = releases.map((release, index) => {
    const isLatest = index === 0;
    const latestClass = isLatest ? "is-latest" : "";
    const newBadge = isLatest ? `<span class="release-badge new-badge" style="background: rgba(231, 76, 60, 0.2); color: #e74c3c; border: 1px solid rgba(231,76,60,0.4); padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: bold;">NEW</span>` : "";
    const isExpanded = isLatest ? "open" : "";

    // Determine badge color class based on type
    let typeClass = "";
    if (release.type === "major") typeClass = "major";
    else if (release.type === "minor") typeClass = "minor";
    else if (release.type === "patch") typeClass = "patch";
    else if (release.type === "hotfix") typeClass = "hotfix";

    // Markdown rendering with Math protection
    let text = release.content || "";
    const mathBlocks = [];
    text = text.replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\(.*?\\\)|\$[^$\n]+?\$)/g, (match) => {
      const id = `__MATH_BLOCK_${mathBlocks.length}__`;
      mathBlocks.push(match);
      return id;
    });

    let htmlContent = "";
    try {
      if (typeof marked !== 'undefined') {
        htmlContent = marked.parse(text);
        if (typeof sanitizeRenderedHtml === 'function') {
          htmlContent = sanitizeRenderedHtml(String(htmlContent));
        }
      } else {
        htmlContent = escapeHtml(text);
      }
    } catch (err) {
      console.error("Marked error in changelog:", err);
      htmlContent = escapeHtml(text);
    }

    mathBlocks.forEach((block, i) => {
      htmlContent = htmlContent.replace(`__MATH_BLOCK_${i}__`, () => block);
    });

    return `
    <details class="release-card ${latestClass}" ${isExpanded}>
      <summary class="release-header">
        <div class="release-header-content">
          <div class="release-meta" style="display: flex; gap: 8px; align-items: center;">
            <span class="release-version" style="font-weight: bold; color: var(--primary);">${escapeHtml(release.version)}</span>
            ${newBadge}
            <span class="release-badge ${typeClass}" style="text-transform: uppercase; font-size: 0.75rem; padding: 2px 6px; border-radius: 4px;">${escapeHtml(release.type)}</span>
            <span class="release-date" style="color: var(--text-soft); font-size: 0.85rem;">${escapeHtml(release.date)}</span>
          </div>
          <h2 class="release-title" style="margin-top: 8px;">${escapeHtml(release.title)}</h2>
        </div>
        <div class="accordion-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
      </summary>
      <div class="release-sections changelog-markdown-body" style="padding: 16px; font-size: 0.95rem; line-height: 1.6; color: var(--text-main);">
        ${htmlContent}
      </div>
    </details>
  `}).join('');

  // Apply Math rendering to the newly rendered changelog content AFTER DOM is updated
  requestAnimationFrame(() => {
    if (typeof renderMathInElement !== "undefined" && ui.changelogContent) {
      try {
        renderMathInElement(ui.changelogContent, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false }
          ],
          ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
          throwOnError: false
        });
      } catch (e) {
        console.error("KaTeX error in changelog:", e);
      }
    }
  });
}

window.addEventListener("popstate", () => {
  if (document.body.dataset.page !== "dashboard") return;

  if (window.location.pathname === "/changelog") {
    toggleChangelogView(true);
  } else {
    toggleChangelogView(false);
  }
});

function renderSettingsPreferences() {
  if (!ui) return;
  // Theme selector buttons
  if (ui.themeSelector) {
    const currentTheme = getSavedTheme();
    ui.themeSelector.querySelectorAll("[data-theme]").forEach((btn) => btn.classList.toggle("active", btn.dataset.theme === currentTheme));
  }
  if (ui.defaultModeSelect) ui.defaultModeSelect.value = getSavedDefaultMode();
  if (ui.defaultNotesModeSelect) ui.defaultNotesModeSelect.value = getSavedDefaultNotesMode();
  if (ui.defaultHinglishToggle) ui.defaultHinglishToggle.checked = getSavedHinglishDefault();
}

function resetPreferences() { setTheme("dark"); saveDefaultMode("general"); saveDefaultNotesMode("normal"); saveHinglishDefault(false); renderSettingsPreferences(); showToast("Settings have been reset.", "success"); }

async function clearCurrentUserChats() {
  if (!state.currentUser) { showToast("Please log in again to manage your chats.", "error"); return; }
  const confirmed = await showConfirm({ label: "Clear History", title: "Clear all chat history?", message: "This will permanently remove every saved chat for your account.", confirmText: "Clear History", type: "danger" });
  if (!confirmed) return;
  try {
    const chatsQuery = query(collection(db, "chats"), where("userId", "==", state.currentUser.uid));
    const snapshot = await getDocs(chatsQuery);
    await Promise.all(snapshot.docs.map((d) => deleteDoc(doc(db, "chats", d.id))));
    showToast("Chat history cleared.", "success");
  } catch (err) { console.error("Clear chat history error:", err); showToast(err.message, "error"); }
}

// ---------------------------------------------------------------------------
// Feedback UI (toasts + confirm modal)
// ---------------------------------------------------------------------------

function initializeFeedbackUi() {
  if (feedbackUi.initialized) return;
  feedbackUi.toastContainer = document.getElementById("toastContainer");
  feedbackUi.confirmModal = document.getElementById("confirmModal");
  feedbackUi.confirmLabel = document.getElementById("confirmModalLabel");
  feedbackUi.confirmTitle = document.getElementById("confirmModalTitle");
  feedbackUi.confirmMessage = document.getElementById("confirmModalMessage");
  feedbackUi.confirmCancelBtn = document.getElementById("confirmCancelBtn");
  feedbackUi.confirmOkBtn = document.getElementById("confirmOkBtn");
  if (feedbackUi.confirmCancelBtn) feedbackUi.confirmCancelBtn.addEventListener("click", () => closeConfirmModal(false));
  if (feedbackUi.confirmOkBtn) feedbackUi.confirmOkBtn.addEventListener("click", () => closeConfirmModal(true));
  if (feedbackUi.confirmModal) feedbackUi.confirmModal.addEventListener("click", (e) => { if (e.target === feedbackUi.confirmModal) closeConfirmModal(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && feedbackUi.confirmModal?.classList.contains("show")) closeConfirmModal(false); });
  feedbackUi.initialized = true;
}

function showToast(message, type = "info") {
  if (!message || !feedbackUi.toastContainer) return;
  const toast = document.createElement("div"); toast.className = `toast ${type}`; toast.textContent = message;
  feedbackUi.toastContainer.appendChild(toast);
  window.setTimeout(() => { toast.classList.add("leaving"); window.setTimeout(() => toast.remove(), 220); }, 3000);
}

function queueFlashToast(message, type = "info") { sessionStorage.setItem(FLASH_TOAST_KEY, JSON.stringify({ message, type })); }

function consumeFlashToast() {
  const raw = sessionStorage.getItem(FLASH_TOAST_KEY); if (!raw) return;
  sessionStorage.removeItem(FLASH_TOAST_KEY);
  try { const d = JSON.parse(raw); showToast(d.message, d.type); } catch (err) { console.error("Toast parse error:", err); }
}

window.copyCode = async function copyCode(button) {
  const codeNode = button?.closest(".code-block")?.querySelector("pre code");
  if (!codeNode) return;
  const codeText = codeNode.innerText || codeNode.textContent || "";

  try {
    await navigator.clipboard.writeText(codeText);
    const originalText = button.textContent;
    button.textContent = "Copied!";
    window.setTimeout(() => {
      button.textContent = originalText || "Copy";
    }, 1500);
  } catch (error) {
    console.error("Code copy failed:", error);
    showToast("Unable to copy code right now.", "error");
  }
};

function showConfirm({ label = "Please Confirm", title = "Are you sure?", message = "This action cannot be undone.", confirmText = "Confirm", cancelText = "Cancel", type = "info" } = {}) {
  if (!feedbackUi.confirmModal) return Promise.resolve(false);
  feedbackUi.confirmLabel.textContent = label; feedbackUi.confirmTitle.textContent = title;
  feedbackUi.confirmMessage.textContent = message; feedbackUi.confirmCancelBtn.textContent = cancelText;
  feedbackUi.confirmOkBtn.textContent = confirmText;
  feedbackUi.confirmOkBtn.classList.toggle("danger-btn", type === "danger");
  feedbackUi.confirmModal.classList.add("show"); feedbackUi.confirmModal.setAttribute("aria-hidden", "false");
  return new Promise((resolve) => { feedbackUi.confirmResolver = resolve; });
}

function closeConfirmModal(result) {
  if (!feedbackUi.confirmModal) return;
  feedbackUi.confirmModal.classList.remove("show"); feedbackUi.confirmModal.setAttribute("aria-hidden", "true");
  feedbackUi.confirmOkBtn.classList.remove("danger-btn");
  if (feedbackUi.confirmResolver) { const resolve = feedbackUi.confirmResolver; feedbackUi.confirmResolver = null; resolve(result); }
}

/**
 * Send a welcome notification when a user first creates their account.
 * Called from ensureUserDocument when a new user doc is created.
 */
async function sendWelcomeNotification(userId) {
  try {
    await createNotification(
      userId,
      "Welcome to StudyMate AI! 🎉",
      "Start a new chat and ask your first question. We support General, Exam, and Coding modes!",
      "success"
    );
  } catch (err) {
    console.error("Welcome notification error:", err);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function setFormMessage(element, message, type) { element.textContent = message; element.className = `form-message ${type}`; }
function delay(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
function getLatestUserMessageFromPayload(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && typeof messages[i]?.content === "string") return messages[i].content;
  }
  return "";
}
function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((src) => src && typeof src.url === "string" && typeof src.title === "string")
    .map((src) => ({ title: src.title.trim(), url: src.url.trim() }))
    .filter((src) => src.title && /^https?:\/\//i.test(src.url))
    .slice(0, 5);
}
function renderMessageSources(message) {
  if (message?.role !== "ai") return "";
  const sources = normalizeSources(message?.sources);
  if (!sources.length) return "";

  // Create overlapping icons for the toggle button
  const maxIcons = 3;
  const iconsMarkup = sources.slice(0, maxIcons).map((src, index) => {
    try {
      const urlObj = new URL(src.url);
      const domain = urlObj.hostname.replace('www.', '');
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      return `<img src="${faviconUrl}" alt="" class="overlap-icon" style="z-index: ${maxIcons - index}" loading="lazy" onerror="this.outerHTML='<div class=\\'overlap-icon-fallback\\' style=\\'z-index: ${maxIcons - index}\\'>${index + 1}</div>'">`;
    } catch (e) {
      return `<div class="overlap-icon-fallback" style="z-index: ${maxIcons - index}">${index + 1}</div>`;
    }
  }).join("");

  // Create individual source chips
  const linksMarkup = sources.map((src, index) => {
    let domain = "Source";
    let faviconHtml = `<div class="source-favicon-fallback">${index + 1}</div>`;
    try {
      const urlObj = new URL(src.url);
      domain = urlObj.hostname.replace('www.', '');
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      faviconHtml = `<img src="${faviconUrl}" alt="" class="source-favicon" loading="lazy" onerror="this.outerHTML='<div class=\\'source-favicon-fallback\\'>${index + 1}</div>'">`;
    } catch (e) { }

    // Use domain as the display text to avoid generic "source 1" titles
    let displayText = domain;

    return `
      <a href="${escapeAttribute(src.url)}" target="_blank" rel="noopener noreferrer" class="source-chip" title="${escapeAttribute(src.title)}">
        ${faviconHtml}
        <span class="source-title">${escapeHtml(displayText)}</span>
      </a>
    `;
  }).join("");

  return `
    <div class="sources-wrapper">
      <div class="sources-toggle-btn" onclick="this.nextElementSibling.classList.toggle('hidden')">
        <div class="overlapping-icons">${iconsMarkup}</div>
        <span class="sources-toggle-text">Sources</span>
      </div>
      <div class="source-chips-container hidden">${linksMarkup}</div>
    </div>
  `;
}
function formatMessage(content, role = "ai", intent = "GENERAL", doubt = false) {
  let text = String(content ?? "").trim();
  if (role !== "ai") return escapeHtml(text).replace(/\n/g, "<br>");

  // 1. Remove "Quiz:" if present in the raw text (backend safety)
  text = text.replace(/Quiz:\s*.*$/is, "").trim();

  // Protect Math blocks from Markdown parser (prevent _ and * from mangling LaTeX)
  const mathBlocks = [];
  // Regex matches: $$...$$, \[...\], \(...\), and $...$ (non-greedy)
  text = text.replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\(.*?\\\)|\$[^$\n]+?\$)/g, (match) => {
    const id = `__MATH_BLOCK_${mathBlocks.length}__`;
    mathBlocks.push(match);
    return id;
  });

  // 2. Parse main content
  let html = "";
  try {
    html = sanitizeRenderedHtml(String(marked.parse(text)));
  } catch (err) {
    console.error("Markdown render error:", err);
    html = escapeHtml(text).replace(/\n/g, "<br>");
  }

  // Restore Math blocks
  mathBlocks.forEach((block, i) => {
    html = html.replace(`__MATH_BLOCK_${i}__`, () => block); // Use function to avoid $ replacement issues
  });

  // 3. Append Reactive UI buttons only if explicitly invited by AI
  if (text.includes("Want a quiz on this?")) {
    const buttonHtml = `
      <div class="followup-box">
        <span class="followup-arrow">➤</span>
        <button class="quiz-trigger-btn" onclick="window.startQuizInteractive(this)">✍️ Take Quiz</button>
      </div>
    `.trim();
    html += buttonHtml;
  }

  return html;
}

/**
 * renderMermaidDiagrams()
 * Safely renders Mermaid diagrams sequentially to prevent parser crashes and concurrency issues.
 */
let mermaidRenderQueue = Promise.resolve();
const MAX_MERMAID_LENGTH = 30000;

async function renderMermaidDiagrams() {
  if (typeof mermaid === "undefined") return;
  if (document.visibilityState !== "visible") {
    // Re-queue when tab becomes visible
    document.addEventListener("visibilitychange", function onVis() {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", onVis);
        renderMermaidDiagrams();
      }
    });
    return;
  }

  const nodes = Array.from(document.querySelectorAll(".mermaid:not([data-mermaid-processed='true'])"));
  if (nodes.length === 0) return;

  mermaidRenderQueue = mermaidRenderQueue.then(async () => {
    for (const node of nodes) {
      if (!node.isConnected) continue; // Skip detached nodes
      if (node.getAttribute("data-mermaid-processed") === "true") continue;

      const rawCode = node.textContent;
      node.setAttribute("data-mermaid-processed", "true");

      if (rawCode.length > MAX_MERMAID_LENGTH) {
        node.innerHTML = `
          <div class="glass-card" style="padding: 1rem; border-left: 4px solid var(--warning-color);">
            <div style="color: var(--warning-color); font-weight: 600; margin-bottom: 0.5rem;">⚠ Diagram Too Large</div>
            <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.5rem;">This Mermaid diagram exceeds the size limit (${MAX_MERMAID_LENGTH} characters) and cannot be safely rendered without freezing the browser.</p>
            <details>
              <summary style="cursor: pointer; color: var(--primary-color);">Show Raw Syntax</summary>
              <pre style="margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-dark); border-radius: 4px; overflow-x: auto; font-size: 0.85rem;"><code>${escapeHtml(rawCode)}</code></pre>
            </details>
          </div>
        `;
        continue;
      }

      const uniqueId = `mermaid-render-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

      try {
        const { svg, bindFunctions } = await mermaid.render(uniqueId, rawCode);
        if (!node.isConnected) continue; // Check again after async parse

        node.innerHTML = svg;
        if (bindFunctions) bindFunctions(node);
      } catch (err) {
        console.error("Mermaid rendering failed for a diagram:", err);
        // Clean up any orphaned elements mermaid.render might have left in the DOM
        const orphanSvg = document.getElementById(uniqueId);
        if (orphanSvg) orphanSvg.remove();

        if (node.isConnected) {
          node.innerHTML = `
            <div class="glass-card" style="padding: 1rem; border-left: 4px solid var(--danger-color);">
              <div style="color: var(--danger-color); font-weight: 600; margin-bottom: 0.5rem;">⚠ Invalid Diagram Syntax</div>
              <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.5rem;">The AI generated invalid Mermaid.js syntax.</p>
              <details>
                <summary style="cursor: pointer; color: var(--primary-color);">Show Raw Syntax</summary>
                <pre style="margin-top: 0.5rem; padding: 0.5rem; background: var(--bg-dark); border-radius: 4px; overflow-x: auto; font-size: 0.85rem;"><code>${escapeHtml(rawCode)}</code></pre>
              </details>
            </div>
          `;
        }
      }
    }
  }).catch(console.error);
}
function formatSidebarDate(timestamp) { const date = timestamp?.toDate ? timestamp.toDate() : new Date(); return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function getTimestampValue(timestamp) { return timestamp?.toMillis ? timestamp.toMillis() : 0; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value ?? ""; return div.innerHTML; }
function escapeAttribute(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function sanitizeRenderedHtml(rawHtml) {
  const template = document.createElement("template");
  template.innerHTML = rawHtml;
  template.content.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value || "";
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      if ((name === "href" || name === "src") && /^\s*javascript:/i.test(value)) el.removeAttribute(attr.name);
    });
  });
  return template.innerHTML;
}

window.startQuizInteractive = function (button) {
  // 1. Set mode to quiz
  const quizModeBtn = document.querySelector('.mode-btn[data-mode="quiz"]');
  if (quizModeBtn) {
    quizModeBtn.click();
  } else {
    state.currentMode = 'quiz';
    renderDashboard();
  }

  // 2. Clear current question state for a fresh start
  state.currentQuestion = null;

  // 3. Send a message to get the first question
  ui.userInput.value = "Start the quiz please!";
  handleSendMessage();
};

// ---------------------------------------------------------------------------
// Versioning System
// ---------------------------------------------------------------------------
async function initVersioning() {
  const versionDisplay = document.getElementById("appVersionDisplay");
  if (!versionDisplay) return;

  let version = "v1.3.0"; // fallback

  if (window.APP_VERSION) {
    version = window.APP_VERSION;
  } else {
    try {
      const res = await fetch("/config/version.json?t=" + Date.now());
      if (res.ok) {
        const data = await res.json();
        if (data.version) version = data.version;
      }
    } catch (_) {
      // ignore
    }
  }

  versionDisplay.textContent = version;
}

// ---------------------------------------------------------------------------
// Device Session Management
// ---------------------------------------------------------------------------

let currentSessionId = null;
let sessionListenerUnsubscribe = null;
let heartbeatIntervalId = null;

function generateUUID() {
  if (crypto && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch (e) { }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getBrowserInfo(ua) {
  ua = (ua || "").toLowerCase();
  let browser = "Unknown Browser";
  if (ua.includes("firefox")) browser = "Firefox";
  else if (ua.includes("samsungbrowser")) browser = "Samsung Internet";
  else if (ua.includes("opera") || ua.includes("opr")) browser = "Opera";
  else if (ua.includes("edge") || ua.includes("edg")) browser = "Edge";
  else if (ua.includes("chrome")) browser = "Chrome";
  else if (ua.includes("safari")) browser = "Safari";

  let os = "Unknown OS";
  if (ua.includes("windows")) os = "Windows";
  else if (ua.includes("mac os")) os = "macOS";
  else if (ua.includes("android")) os = "Android";
  else if (ua.includes("linux")) os = "Linux";
  else if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) os = "iOS";

  const deviceType = ua.includes("mobi") ? "Mobile" : "Desktop";
  return { browser, os, deviceType };
}

async function initDeviceSession(user) {
  if (!user || state.isGuestMode) return;
  const uid = user.uid;

  currentSessionId = localStorage.getItem(STORAGE_KEYS.deviceSessionId);
  if (!currentSessionId) {
    currentSessionId = generateUUID();
    localStorage.setItem(STORAGE_KEYS.deviceSessionId, currentSessionId);
  }

  const { browser, os, deviceType } = getBrowserInfo(navigator.userAgent);
  const sessionRef = doc(db, "users", uid, "sessions", currentSessionId);

  try {
    const sessionSnap = await getDoc(sessionRef);
    if (!sessionSnap.exists()) {
      await setDoc(sessionRef, {
        sessionId: currentSessionId,
        userAgent: navigator.userAgent,
        browser, os, deviceType,
        createdAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
        revokedAt: null
      });
    } else {
      await updateDoc(sessionRef, {
        lastSeenAt: serverTimestamp()
      });
    }

    startSessionHeartbeat(uid, currentSessionId);
    setupSessionRevocationListener(uid, currentSessionId);
  } catch (error) {
    console.error("Failed to init device session:", error);
  }
}

function startSessionHeartbeat(uid, sessionId) {
  if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);

  const performHeartbeat = async () => {
    // Multi-tab check: visibility + localStorage leader election
    if (document.visibilityState === 'hidden') return;

    // Leader election lock
    const lockKey = `studymate_heartbeat_lock_${sessionId}`;
    const now = Date.now();
    const lockVal = localStorage.getItem(lockKey);

    // If another tab grabbed the lock within the last 110s, skip this heartbeat
    if (lockVal && (now - parseInt(lockVal, 10)) < 110000) {
      return;
    }

    // Grab/Renew the lock
    localStorage.setItem(lockKey, now.toString());

    try {
      await updateDoc(doc(db, "users", uid, "sessions", sessionId), {
        lastSeenAt: serverTimestamp()
      });
    } catch (error) {
      console.error("Heartbeat failed:", error);
    }
  };

  // Run heartbeat every 2 minutes
  heartbeatIntervalId = setInterval(performHeartbeat, 120000);

  // Also trigger heartbeat on visibility change if visible
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      performHeartbeat();
    }
  });
}

function setupSessionRevocationListener(uid, sessionId) {
  if (sessionListenerUnsubscribe) sessionListenerUnsubscribe();

  sessionListenerUnsubscribe = onSnapshot(doc(db, "users", uid, "sessions", sessionId), (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    if (data.revokedAt != null) {
      console.warn("Session revoked remotely. Logging out.");
      // Stop streaming if active to avoid corrupting UI or hanging requests
      if (state.streamingResponse) stopStreamingResponse();

      localStorage.removeItem(STORAGE_KEYS.deviceSessionId);
      cleanupDeviceSession();
      signOut(auth).then(() => {
        window.location.replace("/login?revoked=true");
      });
    }
  });
}

function cleanupDeviceSession() {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
  if (sessionListenerUnsubscribe) {
    sessionListenerUnsubscribe();
    sessionListenerUnsubscribe = null;
  }
}

window.addEventListener("beforeunload", () => {
  cleanupDeviceSession();
});

async function revokeCurrentSession(uid) {
  if (!currentSessionId || !uid) return;
  try {
    const sessionRef = doc(db, "users", uid, "sessions", currentSessionId);
    await updateDoc(sessionRef, { revokedAt: serverTimestamp() });
  } catch (err) {
    console.error("Failed to revoke current session:", err);
  }
  localStorage.removeItem(STORAGE_KEYS.deviceSessionId);
}

// ---------------------------------------------------------------------------
// Settings UI: Load and Manage Sessions
// ---------------------------------------------------------------------------

let activeSessionsUnsubscribe = null;

function loadSessions(user) {
  if (activeSessionsUnsubscribe) {
    activeSessionsUnsubscribe();
    activeSessionsUnsubscribe = null;
  }

  if (!state.currentUser?.uid) {
    console.warn("[Sessions] Skipping session load: auth not ready");
    return;
  }
  if (state.isGuestMode) return;

  const sessionsContainer = document.getElementById("sessionsListContainer");
  if (!sessionsContainer) return;

  const q = query(
    collection(db, "users", state.currentUser.uid, "sessions"),
    where("revokedAt", "==", null)
  );

  activeSessionsUnsubscribe = onSnapshot(q, (snapshot) => {
    // Filter out stale sessions (>30 days old without a heartbeat)
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const activeSessions = snapshot.docs.filter(d => {
      const data = d.data();
      const lastSeen = getTimestampValue(data.lastSeenAt);
      return lastSeen > thirtyDaysAgo;
    });

    if (activeSessions.length === 0) {
      sessionsContainer.innerHTML = '<div class="session-loading">No active sessions found.</div>';
      return;
    }

    // Sort: Current device first, then by lastSeenAt descending
    activeSessions.sort((a, b) => {
      const aIsCurrent = a.id === currentSessionId;
      const bIsCurrent = b.id === currentSessionId;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return getTimestampValue(b.data().lastSeenAt) - getTimestampValue(a.data().lastSeenAt);
    });

    sessionsContainer.innerHTML = activeSessions.map(d => {
      const data = d.data();
      const isCurrent = data.sessionId === currentSessionId;
      const badgeHtml = isCurrent ? '<span class="badge success-badge">Current Device</span>' : '';
      const actionHtml = isCurrent
        ? ''
        : `<button class="ghost-btn danger-btn" id="revokeBtn_${data.sessionId}" onclick="window.revokeSession('${data.sessionId}')" style="padding: 0.25rem 0.75rem; font-size: 0.85rem;">Log Out</button>`;

      const lastSeenStr = formatSidebarDate(data.lastSeenAt);

      return `
        <div class="glass-card" style="padding: 1rem; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; flex-direction: column; gap: 0.25rem;">
            <div style="font-weight: 600; display: flex; align-items: center; gap: 0.5rem;">
              ${escapeHtml(data.browser)} on ${escapeHtml(data.os)}
              ${badgeHtml}
            </div>
            <div style="font-size: 0.85rem; color: var(--text-muted);">
              Last active: ${lastSeenStr}
            </div>
          </div>
          <div>
            ${actionHtml}
          </div>
        </div>
      `;
    }).join("");
  }, (error) => {
    console.error("[Sessions] Firestore error:", error);
    console.error("[Sessions] Error code:", error.code);
    console.error("[Sessions] Error message:", error.message);

    sessionsContainer.innerHTML = `
      <div class="session-loading" style="color: var(--danger-color); text-align: left;">
        <div style="font-weight: 600; margin-bottom: 0.5rem;">⚠ Failed to load sessions</div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">${escapeHtml(error.message)}</div>
        <button class="ghost-btn" onclick="window.location.reload()" style="padding: 0.25rem 0.75rem;">Retry</button>
      </div>
    `;
  });
}

window.revokeSession = async function (sessionIdToRevoke) {
  const uid = state.currentUser?.uid;
  if (!uid || sessionIdToRevoke === currentSessionId) return;

  const btn = document.getElementById(`revokeBtn_${sessionIdToRevoke}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Logging out...";
  }

  try {
    const sessionRef = doc(db, "users", uid, "sessions", sessionIdToRevoke);
    await updateDoc(sessionRef, { revokedAt: serverTimestamp() });
    showToast("Device logged out successfully.", "success");
  } catch (error) {
    console.error("Failed to revoke session:", error);
    showToast("Failed to logout device.", "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Log Out";
    }
  }
};

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const logoutAllBtn = document.getElementById("logoutAllSessionsBtn");
    if (logoutAllBtn) {
      logoutAllBtn.addEventListener("click", async () => {
        const uid = state.currentUser?.uid;
        if (!uid || !currentSessionId) return;

        logoutAllBtn.disabled = true;
        logoutAllBtn.textContent = "Logging out...";

        try {
          const q = query(
            collection(db, "users", uid, "sessions"),
            where("revokedAt", "==", null)
          );
          const snapshot = await getDocs(q);
          const batchOp = writeBatch(db);
          let count = 0;

          snapshot.forEach(docSnap => {
            if (docSnap.id !== currentSessionId) {
              batchOp.update(docSnap.ref, { revokedAt: serverTimestamp() });
              count++;
            }
          });

          if (count > 0) {
            await batchOp.commit();
            showToast(`Successfully logged out ${count} other device(s).`, "success");
          } else {
            showToast("No other active devices found.", "info");
          }
        } catch (error) {
          console.error("Failed to revoke all sessions:", error);
          showToast("Failed to logout other devices.", "error");
        } finally {
          logoutAllBtn.disabled = false;
          logoutAllBtn.textContent = "Logout All Other Devices";
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Initialization & Boot Sequence
// ---------------------------------------------------------------------------

/**
 * runAuthGuard(user)
 * Dedicated authentication guard. Validates authentication state, verification, and policies.
 */
async function runAuthGuard(user) {
  const currentPage = document.body.dataset.page;
  const isAuthPage = ["login", "signup", "forgot"].includes(currentPage);
  const isVerifyPage = currentPage === "verify";

  // 1. Fetch/ensure user doc
  const userDocData = await ensureUserDocument(user);
  if (!userDocData) {
     console.error("[AUTH GUARD] User doc missing or could not be fetched.");
     await signOut(auth);
     if (currentPage !== "login") window.location.replace("/login");
     return false;
  }

  // 2. Check if deleted or blocked
  if (userDocData.deleted || userDocData.accountStatus === "deleted") {
     console.warn("[AUTH GUARD] Account is deleted.");
     await signOut(auth);
     if (currentPage !== "login") window.location.replace("/login");
     return false;
  }
  if (userDocData.isBlocked) {
     console.warn("[AUTH GUARD] Account is blocked.");
     await signOut(auth);
     if (currentPage !== "login") window.location.replace("/login");
     return false;
  }

  // 3. Email Verification Check
  const isGoogle = user.providerData.some(p => p.providerId === 'google.com');
  const needsVerification = !isGoogle && !user.emailVerified;
  
  if (needsVerification) {
     console.warn("[AUTH GUARD] User email not verified. Blocking access.");
     if (!isVerifyPage) {
        window.location.replace("/verify");
     }
     return false; 
  } else if (isVerifyPage) {
     console.info("[AUTH GUARD] User is verified. Redirecting from verify page to home.");
     window.location.replace("/");
     return false;
  }

  // 4. Terms Acceptance Check
  const currentVersion = typeof LEGAL_CONFIG !== 'undefined' ? LEGAL_CONFIG.agreementVersion : "1.2.0";
  // We check for acceptedTerms == true AND acceptedPrivacyPolicy == true, OR fallback to legacy agreementAccepted
  const hasAgreed = (userDocData.acceptedTerms && userDocData.acceptedPrivacyPolicy) || userDocData.agreementAccepted;
  const needsConsent = !hasAgreed || (userDocData.agreementVersion && userDocData.agreementVersion !== currentVersion);
  
  if (needsConsent && !isAuthPage && !isVerifyPage) {
    console.info("[AUTH GUARD] Showing terms consent modal.");
    const accepted = await requireTermsAcceptance(user);
    if (!accepted) {
      console.warn("[AUTH GUARD] User refused terms.");
      await signOut(auth);
      window.location.replace("/login");
      return false;
    }
  }

  return true;
}

function requireTermsAcceptance(user) {
  return new Promise((resolve) => {
    const modal = document.getElementById("termsConsentModal");
    const checkbox = document.getElementById("termsConsentCheckbox");
    const acceptBtn = document.getElementById("termsConsentAcceptBtn");
    const logoutBtn = document.getElementById("termsConsentLogoutBtn");

    if (!modal) {
       console.error("Terms modal not found in DOM!");
       resolve(false); 
       return;
    }

    modal.classList.add("show");

    checkbox.addEventListener("change", (e) => {
       acceptBtn.disabled = !e.target.checked;
       acceptBtn.style.opacity = e.target.checked ? "1" : "0.5";
    });

    acceptBtn.onclick = async () => {
      acceptBtn.disabled = true;
      acceptBtn.textContent = "Updating...";
      try {
        const currentVersion = typeof LEGAL_CONFIG !== 'undefined' ? LEGAL_CONFIG.agreementVersion : "1.2.0";
        await updateDoc(doc(db, "users", user.uid), {
           acceptedPrivacyPolicy: true,
           acceptedTerms: true,
           agreementVersion: currentVersion,
           agreementAcceptedAt: serverTimestamp()
        });
        modal.classList.remove("show");
        console.info("[AUTH GUARD] Terms accepted.");
        resolve(true);
      } catch (err) {
        console.error("Failed to accept terms:", err);
        acceptBtn.disabled = false;
        acceptBtn.textContent = "Accept & Continue";
      }
    };

    logoutBtn.onclick = () => {
       resolve(false);
    };
  });
}

/**
 * initAuth()
 * Centralized Firebase Auth listener that serves as the primary gatekeeper.
 */
async function initAuth() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      state.currentUser = user;
      const currentPage = document.body.dataset.page;
      const isAuthPage = ["login", "signup", "forgot"].includes(currentPage);
      const isProtectedPage = ["dashboard", "settings"].includes(currentPage);

      if (!user) {
        if (isProtectedPage) {
          window.location.replace("/login");
          return;
        }
        resolve(null);
        return;
      }

      // Run deep authentication guard checks before allowing access
      const authOk = await runAuthGuard(user);
      if (!authOk) {
        resolve(null);
        return;
      }

      // Check if there's a pending password reset to log
      if (localStorage.getItem("studymate_password_reset_pending") === "true") {
        try {
          await updateDoc(doc(db, "users", user.uid), {
            passwordChangeMethod: "forgot-password",
            passwordChangedAt: serverTimestamp()
          });
          localStorage.removeItem("studymate_password_reset_pending");
          console.info("[AUTH] Logged password reset source to Firestore.");
        } catch (err) {
          console.error("Failed to log password reset source:", err);
        }
      }

      // User is fully authenticated, verified, and accepted terms
      if (isAuthPage) {
        window.location.replace("/");
        return;
      }

      // Initialize Protected App Context for dashboard/settings
      await initApp(user);
      resolve(user);
    });
  });
}

/**
 * initApp(user)
 * Setup shared services for authenticated users.
 */
async function initApp(user) {
  try {
    // Core Shared Init
    const page = document.body.dataset.page;

    if (page === "dashboard") {
      // 1. Initialize core data
      await loadUserSettings();
      await loadUserMemory();
      populateUserInfo(user);

      // 2. Load Chats and Hydrate Persistence FIRST
      // This MUST happen before any Firestore writes (like Session initialization) 
      // to prevent empty cache snapshots from destroying preferredChatId.
      startDashboardApp(user);

      // 3. Post-load operations
      await maybeHandleOnboardingForUser(user);
      await initDeviceSession(user);

      // 4. Hide skeleton — all critical UI and async data are now rendered
      hideSkeletonOverlay("dashboardSkeleton");
    } else if (page === "settings") {
      await loadUserSettings();
      await loadUserMemory();
      populateUserInfo(user);
      await loadUsageStats();
      loadSessions(user);
      await initDeviceSession(user);

      // Hide skeleton — settings data is fully loaded and rendered
      hideSkeletonOverlay("settingsSkeleton");
    }
  } catch (err) {
    console.error("App Initialization Error:", err);
    // Still hide skeletons on error to avoid permanent loading state
    const page = document.body.dataset.page;
    if (page === "dashboard") hideSkeletonOverlay("dashboardSkeleton");
    if (page === "settings") hideSkeletonOverlay("settingsSkeleton");
  }
}

/**
 * populateUserInfo(user)
 * Safely populates user-specific UI elements across different pages.
 */
function populateUserInfo(user) {
  if (!user || !ui) return;
  const name = user.displayName || "User";
  const email = user.email || "No emailFound";
  const photo = user.photoURL || "";
  const isGoogle = user.providerData[0]?.providerId === 'google.com';

  // Dashboard elements
  if (document.body.dataset.page === "dashboard") {
    displayUserProfile(name, email, photo);
  }

  // Settings elements
  if (ui.settingsEmailInput) ui.settingsEmailInput.value = email;
  if (ui.settingsNameInput) ui.settingsNameInput.value = name;
  if (ui.settingsAvatarUrlInput) ui.settingsAvatarUrlInput.value = photo;
  if (ui.settingsDisplayHeader) ui.settingsDisplayHeader.textContent = name;
  if (ui.settingsEmailHeader) ui.settingsEmailHeader.textContent = email;
  if (ui.settingsAvatarPreview && photo) ui.settingsAvatarPreview.src = photo;
  if (ui.googleAccountStatus) ui.googleAccountStatus.textContent = isGoogle ? "Linked (Google)" : "Not Linked";
}

/**
 * bootstrap()
 * The main entry point. Runs basic UI setup then hands off to Auth.
 */
async function bootstrap() {
  try {
    // 0. Firebase Action Link Detection (MUST run before anything else)
    // When a user clicks a password reset / email verification / account recovery
    // link from Firebase, the URL contains mode & oobCode params.
    // We detect these and redirect to the appropriate handler page.
    const actionParams = new URLSearchParams(window.location.search);
    const actionMode = actionParams.get("mode");
    const actionOobCode = actionParams.get("oobCode");

    if (actionMode && actionOobCode) {
      console.log("[AUTH ACTION] Detected Firebase action link:", actionMode);
      console.log("[AUTH ACTION] oobCode present:", !!actionOobCode);

      const currentPath = window.location.pathname.toLowerCase();
      const isAlreadyOnHandler = currentPath.includes("/reset")
        || currentPath.includes("/verify")
        || currentPath.includes("/recover");

      if (!isAlreadyOnHandler) {
        let targetPage = null;

        if (actionMode === "resetPassword") {
          targetPage = "/reset";
        } else if (actionMode === "verifyEmail") {
          targetPage = "/verify";
        } else if (actionMode === "recoverEmail") {
          targetPage = "/recover";
        }

        if (targetPage) {
          console.log("[AUTH ACTION] Redirecting to:", targetPage);
          window.location.replace(`${targetPage}?${actionParams.toString()}`);
          return; // Stop bootstrap — we're redirecting
        }
      }
    }

    // 1. Basic UI & Theme (Safe to run before auth)
    initializeFeedbackUi();
    applySavedTheme();
    consumeFlashToast();

    // 2. Initialize Mermaid (Lazy Singleton)
    initMermaidSingleton();

    // 3. Initialize Seamless SPA Navigation & View Routing
    spaNavigation.init();
    window.spaNavigation = spaNavigation;
    spaNavigation.onNavigate(async (targetPath, dataPage) => {
      applySavedTheme();
      if (ui?.profileDropdown) ui.profileDropdown.classList.remove("show");
      closeModeDropdown();
      closeNotesDropdown();

      if (dataPage === "settings") {
        try {
          initSettingsPage();
          if (state.currentUser) {
            try { await loadUserSettings(); } catch (e) { console.warn("[Settings] loadUserSettings error:", e); }
            try { await loadUserMemory(); } catch (e) { console.warn("[Settings] loadUserMemory error:", e); }
            try { populateUserInfo(state.currentUser); } catch (e) { console.warn("[Settings] populateUserInfo error:", e); }
            try { await loadUsageStats(); } catch (e) { console.warn("[Settings] loadUsageStats error:", e); }
            try { loadSessions(state.currentUser); } catch (e) { console.warn("[Settings] loadSessions error:", e); }
          }
        } catch (err) {
          console.error("[Settings] Page init error:", err);
        } finally {
          hideSkeletonOverlay("settingsSkeleton");
        }
      } else if (dataPage === "dashboard") {
        try {
          initDashboardPage();
          if (state.currentUser) {
            startDashboardApp(state.currentUser);
            populateUserInfo(state.currentUser);
            renderHistory();
            renderMessages();
          }
        } catch (err) {
          console.error("[Dashboard] Page init error:", err);
        } finally {
          hideSkeletonOverlay("dashboardSkeleton");
        }
      }
    });

    // 4. Initialize Page-Specific UI Bindings
    const page = document.body.dataset.page;
    if (page === "login") initLoginPage();
    if (page === "signup") initSignupPage();
    if (page === "settings") initSettingsPage();
    if (page === "dashboard") initDashboardPage();

    // 5. Auth Gatekeeper (Handles redirects and initApp)
    await initAuth();
    if (state.currentUser) {
      spaNavigation.setUser(state.currentUser);
    }

  } catch (err) {
    console.error("StudyMate Bootstrap Error:", err);
  } finally {
    hideSkeletonOverlay("dashboardSkeleton");
    hideSkeletonOverlay("settingsSkeleton");
  }
}

// ---------------------------------------------------------------------------
// Consolidated Page & Stream Utilities
// ---------------------------------------------------------------------------

function updateStreamUI(text) {
  const streamContainer = document.querySelector("[data-stream-content]");
  if (!streamContainer) return;

  // Directly update inner HTML of the active stream bubble
  streamContainer.innerHTML = formatMessage(text, "ai");
  // CRITICAL: DO NOT call renderMermaidDiagrams() here. 
  // It causes parser crashes during incomplete token streams.
}

function initMermaidSingleton() {
  if (typeof mermaid === "undefined") return;
  if (!window.__MERMAID_INITIALIZED__) {
    mermaid.initialize({
      startOnLoad: false,
      theme: document.body.classList.contains("light") ? "default" : "dark",
      securityLevel: "strict",
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: "basis" }
    });
    window.__MERMAID_INITIALIZED__ = true;
  }
}

function generateSafeFallbackReply() {
  return "I'm currently experiencing a high volume of requests, but I've processed your input. Please try refreshing or rephrasing your question if the response above seems incomplete.";
}

function scrollMessagesToBottom(force = false) {
  const container = document.querySelector(".chat-container") || ui?.chatMessages;
  if (!container) return;

  // Strict: Only scroll if forced or if user is already at bottom
  // However, user requested: "Only scroll on chat open. Do NOT scroll on chunks."
  // So we only force scroll when specifically asked (force=true)
  if (!force) return;

  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

// Global start
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}

// ---------------------------------------------------------------------------
// PAGE-SPECIFIC DOM LOADED HANDLERS
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  // Stop link clicks inside the agreement label from toggling the checkbox
  const agreementLinks = document.querySelectorAll(".agreement-text a");
  agreementLinks.forEach(link => {
    link.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  });
});
