import { auth } from "./firebase.js";
import { checkActionCode, applyActionCode } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const statusMsg = document.getElementById("status-message");
const successActions = document.getElementById("success-actions");
const loader = document.querySelector(".loader");

const params = new URLSearchParams(window.location.search);
const oobCode = params.get("oobCode");

if (!oobCode || oobCode.length < 20) {
    showError("Invalid or missing recovery link. Please try again.");
} else {
    handleRecovery();
}

async function handleRecovery() {
    try {
        // Step 1: Verify the code is still valid
        const info = await checkActionCode(auth, oobCode);
        const email = info.data.email;
        
        statusMsg.textContent = `Restoring account for ${email}...`;
        
        // Step 2: Apply the recovery code
        await applyActionCode(auth, oobCode);
        
        showSuccess("Account restored successfully! Your previous email address is now active again.");
    } catch (error) {
        console.error("Recovery error:", error);
        let msg = "The recovery link is invalid or has expired.";
        if (error.code === "auth/invalid-action-code") msg = "This recovery link has already been used.";
        showError(msg);
    }
}

function showSuccess(message) {
    if (loader) loader.style.display = "none";
    statusMsg.textContent = message;
    statusMsg.className = "success-text";
    if (successActions) successActions.style.display = "block";
}

function showError(message) {
    if (loader) loader.style.display = "none";
    statusMsg.textContent = message;
    statusMsg.className = "error-text";
    if (successActions) successActions.style.display = "block";
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
