/**
 * StudyMate AI — Legal Pages Navigation Controller
 * Handles back navigation safely without inline scripts or inline event handlers.
 */
document.addEventListener("DOMContentLoaded", () => {
  const backBtn = document.getElementById("backBtn");
  if (backBtn) {
    if (document.referrer && document.referrer !== window.location.href) {
      backBtn.textContent = "← Back";
    } else {
      backBtn.textContent = "← Return Home";
    }

    backBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.history.length > 1 && document.referrer && document.referrer !== window.location.href) {
        window.history.back();
      } else {
        window.location.href = "/";
      }
    });
  }
});
