import { auth } from "./firebase.js";
import { verifyPasswordResetCode, confirmPasswordReset, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// ---------------------------------------------------------------------------
// Password Reset Handler
// ---------------------------------------------------------------------------
// This script handles the password reset flow when a user clicks the
// reset link from their email. It:
// 1. Extracts the oobCode from the URL
// 2. Verifies the code is still valid (not expired/used)
// 3. Shows the reset form if valid
// 4. Submits the new password to Firebase Auth
// 5. Optionally auto-logs in the user
// ---------------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const oobCode = params.get("oobCode");

// DOM references
const loadingEl = document.getElementById("resetLoading");
const errorEl = document.getElementById("resetError");
const formEl = document.getElementById("resetForm");
const subtitleEl = document.getElementById("resetSubtitle");
const errorTitleEl = document.getElementById("resetErrorTitle");
const errorMessageEl = document.getElementById("resetErrorMessage");
const statusMsg = document.getElementById("statusMessage");
const resetBtn = document.getElementById("resetBtn");

// Debug logging
console.log("[RESET] Page loaded");
console.log("[RESET] Full URL:", window.location.href);
console.log("[RESET] oobCode present:", !!oobCode);
console.log("[RESET] oobCode length:", oobCode ? oobCode.length : 0);

// ---------------------------------------------------------------------------
// State management helpers
// ---------------------------------------------------------------------------

function showLoading() {
  if (loadingEl) loadingEl.style.display = "flex";
  if (errorEl) errorEl.classList.remove("visible");
  if (formEl) formEl.classList.remove("visible");
}

function showError(title, message) {
  if (loadingEl) loadingEl.style.display = "none";
  if (errorEl) {
    errorEl.classList.add("visible");
    if (errorTitleEl) errorTitleEl.textContent = title;
    if (errorMessageEl) errorMessageEl.textContent = message;
  }
  if (formEl) formEl.classList.remove("visible");
  console.error("[RESET] Error:", title, "-", message);
}

function showForm(email) {
  if (loadingEl) loadingEl.style.display = "none";
  if (errorEl) errorEl.classList.remove("visible");
  if (formEl) formEl.classList.add("visible");
  if (subtitleEl) {
    subtitleEl.textContent = email
      ? `Enter a new password for ${email}`
      : "Enter your new password below.";
  }
  console.log("[RESET] Form shown for email:", email || "(unknown)");
}

function setStatus(text, type = "info") {
  if (!statusMsg) return;
  statusMsg.textContent = text;
  statusMsg.style.color = type === "error" ? "#ef4444" : type === "success" ? "#4ade80" : "#94a3b8";
  statusMsg.style.fontWeight = type === "error" ? "bold" : "normal";
}

// ---------------------------------------------------------------------------
// Step 1: Validate the oobCode
// ---------------------------------------------------------------------------

if (!oobCode || oobCode.length < 10) {
  console.error("[RESET] Missing or invalid oobCode in URL");
  showError(
    "Invalid Reset Link",
    "No valid password reset code found in this link. Please request a new reset link from the Login page."
  );
} else {
  // Verify the reset code with Firebase
  verifyResetCode();
}

async function verifyResetCode() {
  showLoading();
  console.log("[RESET] Verifying reset code with Firebase...");

  try {
    // verifyPasswordResetCode returns the email associated with the reset code
    const email = await verifyPasswordResetCode(auth, oobCode);
    console.log("[RESET] Reset code verified successfully for:", email);

    // Store email for auto-login after reset
    if (email) {
      localStorage.setItem("resetEmail", email);
    }

    // Show the password reset form
    showForm(email);

  } catch (error) {
    console.error("[RESET] Code verification failed:", error.code, error.message);

    if (error.code === "auth/expired-action-code") {
      showError(
        "Link Expired",
        "This password reset link has expired. Please request a new one from the Login page."
      );
    } else if (error.code === "auth/invalid-action-code") {
      showError(
        "Link Already Used",
        "This password reset link has already been used or is invalid. Please request a new one from the Login page."
      );
    } else if (error.code === "auth/user-disabled") {
      showError(
        "Account Disabled",
        "The account associated with this reset link has been disabled. Please contact support."
      );
    } else if (error.code === "auth/user-not-found") {
      showError(
        "Account Not Found",
        "No account was found for this reset link. It may have been deleted."
      );
    } else {
      showError(
        "Verification Failed",
        "Unable to verify this reset link. Please try requesting a new one. Error: " + (error.message || error.code)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: Handle form submission
// ---------------------------------------------------------------------------

if (resetBtn) {
  resetBtn.onclick = async () => {
    if (!oobCode) {
      setStatus("No reset code found. Please use the link from your email.", "error");
      return;
    }

    const newPassword = document.getElementById("newPassword")?.value || "";
    const confirmPassword = document.getElementById("confirmPassword")?.value || "";

    // Validation
    if (!newPassword) {
      setStatus("Please enter a new password.", "error");
      return;
    }

    if (newPassword.length < 6) {
      setStatus("Password must be at least 6 characters long.", "error");
      return;
    }

    if (newPassword !== confirmPassword) {
      setStatus("Passwords do not match.", "error");
      return;
    }

    try {
      console.log("[RESET] Submitting new password...");
      resetBtn.disabled = true;
      resetBtn.innerHTML = `
        <span class="spinner" style="display:inline-block; width:16px; height:16px; border:2px solid rgba(255,255,255,0.3); border-top-color:#fff; border-radius:50%; animation:spin 0.8s linear infinite; margin-right:8px;"></span>
        Updating...
      `;

      // Confirm the password reset with Firebase
      await confirmPasswordReset(auth, oobCode, newPassword);
      console.log("[RESET] Password reset successful!");
      
      // Set flag so we can log this to Firestore on next login
      localStorage.setItem("studymate_password_reset_pending", "true");

      // Success flow
      showResetSuccess(newPassword);

    } catch (error) {
      console.error("[RESET] Password reset error:", error.code, error.message);

      let errorText = "An error occurred. Please try again.";
      if (error.code === "auth/expired-action-code") {
        errorText = "The reset link has expired. Please request a new one.";
      } else if (error.code === "auth/invalid-action-code") {
        errorText = "The reset link is invalid or has already been used.";
      } else if (error.code === "auth/weak-password") {
        errorText = "Password is too weak. Please use at least 6 characters.";
      } else if (error.code === "auth/user-disabled") {
        errorText = "This account has been disabled.";
      } else if (error.code === "auth/user-not-found") {
        errorText = "No account found for this reset link.";
      }

      setStatus(errorText, "error");
      resetBtn.textContent = "Update Password";
      resetBtn.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Step 3: Success flow with optional auto-login
// ---------------------------------------------------------------------------

function showResetSuccess(newPassword) {
  let target = "/login";
  let targetLabel = "login";
  const email = localStorage.getItem("resetEmail");
  let autoLoginSuccess = false;

  console.log("[RESET] Attempting auto-login for:", email || "(no email stored)");

  const performAutoLogin = async () => {
    if (email && newPassword) {
      try {
        await signInWithEmailAndPassword(auth, email, newPassword);
        target = "/";
        targetLabel = "dashboard";
        autoLoginSuccess = true;
        localStorage.removeItem("resetEmail");
        console.log("[RESET] Auto-login successful!");
      } catch (err) {
        console.warn("[RESET] Auto-login failed (non-critical):", err.code);
      }
    }
  };

  performAutoLogin().then(() => {
    document.body.innerHTML = `
      <div class="success-container" style="display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:24px;">
        <div class="success-card" style="background:rgba(15,23,42,0.9);border:1px solid rgba(59,130,246,0.2);border-radius:16px;padding:40px;text-align:center;max-width:400px;width:100%;backdrop-filter:blur(12px);">
          <div style="font-size:48px;margin-bottom:16px;">✅</div>
          <h2 style="color:#fff;margin-bottom:8px;font-family:'Outfit',sans-serif;">Password Updated!</h2>
          <p style="color:#94a3b8;margin-bottom:16px;">Your password has been successfully reset.</p>
          ${autoLoginSuccess ? '<p style="color:#4ade80;font-weight:600;">Logging you in automatically...</p>' : ""}
          <p style="color:#64748b;font-size:14px;">Redirecting to ${targetLabel} in <strong id="timer" style="color:#3b82f6;">3</strong>s...</p>
        </div>
      </div>
    `;

    let time = 3;
    const timerEl = document.getElementById("timer");

    const interval = setInterval(() => {
      time--;
      if (timerEl) timerEl.textContent = time;

      if (time <= 0) {
        clearInterval(interval);
        console.log("[RESET] Redirecting to:", target);
        window.location.replace(target);
      }
    }, 1000);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const backBtn = document.getElementById("backBtn");
  if (backBtn) {
    backBtn.textContent = (document.referrer && document.referrer !== window.location.href) ? "← Back" : "Back to Login";
    backBtn.addEventListener("click", () => {
      if (document.referrer && document.referrer !== window.location.href) {
        window.history.back();
      } else {
        window.location.href = "/login";
      }
    });
  }
});

