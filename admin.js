import { auth, db } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, setDoc, getDocs, deleteDoc, query, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { sendAdminNotification } from "./services/notificationService.js";
import { initSignupLogs } from "./adminSignupLogs.js";
import { initSecurityLogs } from "./adminSecurityLogs.js";

// â”€â”€ DOM Elements â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const dom = {
  body: document.body,
  authLoader: document.getElementById("authLoader"),
  toastContainer: document.getElementById("toastContainer"),
  
  // Tabs
  tabBtns: document.querySelectorAll(".admin-tab-btn"),
  tabContents: document.querySelectorAll(".admin-tab-content"),
  
  // Notification Control
  form: document.getElementById("adminNotifForm"),
  titleInput: document.getElementById("notifTitle"),
  messageInput: document.getElementById("notifMessage"),
  typeSelect: document.getElementById("notifType"),
  targetInputs: document.getElementsByName("targetType"),
  targetCards: document.querySelectorAll(".target-card"),
  singleUserGroup: document.getElementById("singleUserGroup"),
  targetUidInput: document.getElementById("targetUid"),
  sendBtn: document.getElementById("sendBtn"),
  previewSlot: document.getElementById("previewSlot"),
  titleCounter: document.getElementById("titleCounter"),
  messageCounter: document.getElementById("messageCounter"),
  titleError: document.getElementById("titleError"),
  messageError: document.getElementById("messageError"),
  uidError: document.getElementById("uidError"),

  // Changelog Management
  clForm: document.getElementById("adminChangelogForm"),
  clIdInput: document.getElementById("changelogId"),
  clVersion: document.getElementById("changelogVersion"),
  clType: document.getElementById("changelogType"),
  clTitle: document.getElementById("changelogTitle"),
  clSummary: document.getElementById("changelogSummary"),
  clContent: document.getElementById("changelogContentInput"),
  clTags: document.getElementById("changelogTags"),
  clPublished: document.getElementById("changelogPublished"),
  clNotify: document.getElementById("changelogNotify"),
  clSaveBtn: document.getElementById("saveChangelogBtn"),
  clClearBtn: document.getElementById("clearChangelogBtn"),
  clErrorMsg: document.getElementById("changelogErrorMsg"),
  clPreview: document.getElementById("changelogPreviewSlot"),
  clHistoryList: document.getElementById("changelogHistoryList"),
  runMigrationBtn: document.getElementById("runMigrationBtn"),
  
  // Modals
  deleteConfirmModal: document.getElementById("deleteConfirmModal"),
  confirmDeleteBtn: document.getElementById("confirmDeleteBtn"),
  cancelDeleteBtn: document.getElementById("cancelDeleteBtn")
};

const NOTIFICATION_TYPE_ICONS = {
  info: "â„¹ï¸",
  success: "âœ…",
  warning: "âš ï¸"
};

// â”€â”€ Authorization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const initAuth = () => {
  // Wait for auth state
  const unsubscribe = onAuthStateChanged(auth, async (user) => {
    unsubscribe(); // Only check once on load

    const startTime = Date.now();
    const skeleton = document.getElementById("adminSkeleton");
    const content = document.getElementById("adminContent");

    const showDashboard = () => {
      const elapsed = Date.now() - startTime;
      const minVisible = Math.max(0, 250 - elapsed);
      setTimeout(() => {
        if (skeleton) {
          skeleton.classList.add("skeleton-hidden");
          skeleton.addEventListener("transitionend", () => skeleton.remove(), { once: true });
          // Safety fallback: remove after 400ms if transitionend doesn't fire
          setTimeout(() => { if (skeleton.parentNode) skeleton.remove(); }, 400);
        }
        if (content) content.style.display = "block";
        document.body.style.opacity = "1";
        document.body.style.pointerEvents = "auto";
      }, minVisible);
    };

    if (user) {
      try {
        const tokenResult = await user.getIdTokenResult(true);
        if (tokenResult.claims.admin) {
          setupUI();
          showDashboard();
        } else {
          window.location.replace("index.html");
        }
      } catch (err) {
        console.error("Auth error:", err);
        window.location.replace("index.html");
      }
    } else {
      window.location.replace("index.html");
    }
    unsubscribe(); // Stop listening after first check
  });
};

const setupUI = () => {
  // Hide loader and show body
  if (dom.authLoader) dom.authLoader.style.display = "none";
  dom.body.classList.add("ready");

  // Initialize all tab modules
  initSignupLogs();
  initSecurityLogs();

  dom.tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      dom.tabBtns.forEach(b => b.classList.remove("active"));
      dom.tabContents.forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

  // Initialize dynamic listeners
  bindEvents();
  updatePreview(); // Initial preview
  dom.titleInput.focus();
  
  // Initialize Changelog system
  initChangelogSystem();
  
  // Initialize KB System
  initKbSystem();
};

// â”€â”€ Live Preview & Debounce â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let debounceTimer;
const debounce = (callback, delay) => {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(callback, delay);
};

const updatePreview = () => {
  const title = dom.titleInput.value.trim() || "Notification Title";
  const message = dom.messageInput.value.trim() || "Your message will appear here precisely as users will see it in their dashboard.";
  const type = dom.typeSelect.value;
  const icon = NOTIFICATION_TYPE_ICONS[type] || "â„¹ï¸";

  dom.previewSlot.innerHTML = `
    <div class="notification-root">
      <div class="notification-item unread">
        <div class="notification-icon type-${type}">${icon}</div>
        <div class="notification-body">
          <p class="notification-title">${escapeHtml(title)}</p>
          <p class="notification-message">${escapeHtml(message)}</p>
          <span class="notification-time">Just now</span>
        </div>
      </div>
    </div>
  `;
};

// â”€â”€ Form Handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const bindEvents = () => {
  // Real-time preview with debounce
  dom.titleInput.addEventListener("input", () => {
    updateCounters();
    debounce(updatePreview, 150);
  });
  dom.messageInput.addEventListener("input", () => {
    updateCounters();
    debounce(updatePreview, 150);
  });
  dom.typeSelect.addEventListener("change", updatePreview);

  // Target radio handling
  dom.targetCards.forEach(card => {
    card.addEventListener("click", () => {
      const radio = card.querySelector('input[type="radio"]');
      radio.checked = true;
      
      // Update visual active state
      dom.targetCards.forEach(c => c.classList.remove("active"));
      card.classList.add("active");

      // Toggle UID input visibility
      const hideUid = radio.value === "broadcast";
      dom.singleUserGroup.classList.toggle("hidden", hideUid);
      
      if (!hideUid) dom.targetUidInput.focus();
    });
  });

  dom.form.addEventListener("submit", handleSubmit);
};

const updateCounters = () => {
  dom.titleCounter.textContent = `${(dom.titleInput.value || "").length} / 100`;
  dom.messageCounter.textContent = `${(dom.messageInput.value || "").length} / 300`;
};

const validateForm = () => {
  let isValid = true;
  const title = dom.titleInput.value.trim();
  const message = dom.messageInput.value.trim();
  const targetType = [...dom.targetInputs].find(r => r.checked)?.value;
  const targetUid = dom.targetUidInput.value.trim();

  // Reset errors
  dom.titleError.classList.remove("show");
  dom.messageError.classList.remove("show");
  dom.uidError.classList.remove("show");

  if (!title || title.length < 3) {
    dom.titleError.classList.add("show");
    isValid = false;
  }
  if (!message || message.length < 5) {
    dom.messageError.classList.add("show");
    isValid = false;
  }
  if (targetType === "single" && !targetUid) {
    dom.uidError.classList.add("show");
    isValid = false;
  }

  return isValid;
};

const handleSubmit = async (e) => {
  e.preventDefault();
  
  if (!validateForm()) return;

  const targetType = [...dom.targetInputs].find(r => r.checked)?.value;
  const isBroadcast = targetType === "broadcast";
  
  // HIGH IMPACT: Broadcast confirmation
  if (isBroadcast) {
    const confirmed = confirm("âš ï¸ Are you sure you want to broadcast this notification to ALL users?");
    if (!confirmed) return;
  }

  const payload = {
    title: dom.titleInput.value.trim(),
    message: dom.messageInput.value.trim(),
    type: dom.typeSelect.value
  };

  if (!isBroadcast) {
    payload.targetUid = dom.targetUidInput.value.trim();
  }

  // Loading state
  setLoading(true);

  try {
    const result = await sendAdminNotification(payload);

    if (!result?.success) {
      throw new Error(result?.detail || "Failed to dispatch notification.");
    }

    showToast("Notification dispatched successfully!", "success");
    dom.form.reset();
    updateCounters();
    updatePreview();
    // Reset target to broadcast visual
    dom.targetCards[0].click();
  } catch (err) {
    console.error("Submission error:", err);
    console.error("  → Error code:", err?.code);
    console.error("  → Error cause:", err?.cause);
    showToast(getErrorMessage(err), "error");
  } finally {
    setLoading(false);
  }
};

const setLoading = (loading) => {
  dom.sendBtn.disabled = loading;
  dom.sendBtn.innerHTML = loading 
    ? `<div class="spinner-ring" style="width:18px; height:18px; border-width:2px;"></div> Sending...`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
      <span>Dispatch Notification</span>`;
};

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const showToast = (message, type = "success") => {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  if (dom.toastContainer) {
    dom.toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  } else {
    alert(`${type.toUpperCase()}: ${message}`);
  }
};

const escapeHtml = (unsafe) => {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const getErrorMessage = (err) => {
  if (!err) return "An error occurred during dispatch.";
  if (typeof err.message === "string" && err.message.trim()) return err.message;
  if (typeof err.detail === "string" && err.detail.trim()) return err.detail;
  return "An error occurred during dispatch.";
};

// â”€â”€ Changelog Management Logic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let changelogs = [];
let deleteTargetId = null;

const initChangelogSystem = () => {
  dom.clContent.addEventListener("input", () => {
    debounce(updateChangelogPreview, 300);
    saveChangelogDraft();
  });
  dom.clVersion.addEventListener("input", saveChangelogDraft);
  dom.clTitle.addEventListener("input", saveChangelogDraft);
  dom.clSummary.addEventListener("input", saveChangelogDraft);
  dom.clType.addEventListener("change", updateChangelogPreview);
  
  dom.clForm.addEventListener("submit", handleChangelogSubmit);
  dom.clClearBtn.addEventListener("click", clearChangelogForm);
  
  dom.runMigrationBtn.addEventListener("click", migrateJsonToFirestore);
  
  dom.cancelDeleteBtn.addEventListener("click", () => {
    dom.deleteConfirmModal.style.display = "none";
    deleteTargetId = null;
  });
  dom.confirmDeleteBtn.addEventListener("click", confirmDeleteChangelog);

  loadChangelogDraft();
  fetchChangelogHistory();
};

const updateChangelogPreview = () => {
  const content = dom.clContent.value.trim();
  const title = dom.clTitle.value.trim() || "Update Title";
  const version = dom.clVersion.value.trim() || "vX.X.X";
  const type = dom.clType.value;
  
  // Protect Math blocks from Markdown parser
  let text = content;
  const mathBlocks = [];
  text = text.replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\(.*?\\\)|\$[^$\n]+?\$)/g, (match) => {
    const id = `__MATH_BLOCK_${mathBlocks.length}__`;
    mathBlocks.push(match);
    return id;
  });

  let html = "";
  try {
    html = typeof marked !== 'undefined' ? marked.parse(text) : escapeHtml(text);
  } catch (err) {
    html = escapeHtml(text);
  }

  // Restore Math blocks
  mathBlocks.forEach((block, i) => {
    html = html.replace(`__MATH_BLOCK_${i}__`, () => block);
  });

  dom.clPreview.innerHTML = `
    <div style="margin-bottom: 16px; border-bottom: 1px solid var(--border-color); padding-bottom: 12px;">
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: bold; color: var(--primary);">${escapeHtml(version)}</span>
        <span class="release-badge ${type}">${type}</span>
      </div>
      <h2 style="margin: 0; font-size: 1.5rem;">${escapeHtml(title)}</h2>
    </div>
    <div class="changelog-markdown-body">
      ${html || "<span style='color: var(--text-soft);'>Markdown content preview will appear here...</span>"}
    </div>
  `;

  // Render Math
  if (typeof renderMathInElement !== "undefined") {
    try {
      renderMathInElement(dom.clPreview, {
        delimiters: [
          {left: '$$', right: '$$', display: true},
          {left: '\\[', right: '\\]', display: true},
          {left: '$', right: '$', display: false},
          {left: '\\(', right: '\\)', display: false}
        ],
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
        throwOnError: false
      });
    } catch(e) {}
  }
};

const saveChangelogDraft = () => {
  const draft = {
    version: dom.clVersion.value,
    title: dom.clTitle.value,
    summary: dom.clSummary.value,
    content: dom.clContent.value,
    type: dom.clType.value,
    tags: dom.clTags.value
  };
  localStorage.setItem("admin_changelog_draft", JSON.stringify(draft));
};

const loadChangelogDraft = () => {
  try {
    const draft = JSON.parse(localStorage.getItem("admin_changelog_draft"));
    if (draft && !dom.clIdInput.value) {
      dom.clVersion.value = draft.version || "";
      dom.clTitle.value = draft.title || "";
      dom.clSummary.value = draft.summary || "";
      dom.clContent.value = draft.content || "";
      dom.clType.value = draft.type || "patch";
      dom.clTags.value = draft.tags || "";
      updateChangelogPreview();
    }
  } catch(e) {}
};

const clearChangelogForm = () => {
  dom.clForm.reset();
  dom.clIdInput.value = "";
  dom.clType.value = "patch";
  localStorage.removeItem("admin_changelog_draft");
  updateChangelogPreview();
};

const fetchChangelogHistory = async () => {
  try {
    const q = query(collection(db, "changelogs"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    changelogs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderChangelogHistory();
  } catch (err) {
    console.error("Failed to fetch changelogs", err);
    dom.clHistoryList.innerHTML = `<div style="text-align:center; color: #e74c3c;">Failed to load history</div>`;
  }
};

const renderChangelogHistory = () => {
  if (!Array.isArray(changelogs) || changelogs.length === 0) {
    dom.clHistoryList.innerHTML = `<div style="text-align:center; color: var(--text-soft);">No changelogs found</div>`;
    return;
  }
  
  dom.clHistoryList.innerHTML = changelogs.map(cl => {
    const date = cl.createdAt ? new Date(cl.createdAt.toMillis()).toLocaleDateString() : "Draft";
    const pubBadge = cl.published 
      ? `<span class="release-badge success" style="background: rgba(46, 204, 113, 0.2); color: #2ecc71;">Published</span>` 
      : `<span class="release-badge draft">Draft</span>`;
      
    return `
      <div class="changelog-history-item">
        <div class="history-item-header">
          <span class="history-item-title">${escapeHtml(cl.version)} - ${escapeHtml(cl.title)}</span>
          ${pubBadge}
        </div>
        <div class="history-item-meta">
          <span class="release-badge ${escapeHtml(cl.releaseType)}">${escapeHtml(cl.releaseType)}</span>
          <span>${date}</span>
        </div>
        <div class="history-item-actions">
          <button class="history-btn" onclick="window.editChangelog('${cl.id}')">Edit</button>
          <button class="history-btn delete" onclick="window.requestDeleteChangelog('${cl.id}')">Delete</button>
        </div>
      </div>
    `;
  }).join("");
};

window.editChangelog = (id) => {
  const cl = changelogs.find(c => c.id === id);
  if (!cl) return;
  dom.clIdInput.value = cl.id;
  dom.clVersion.value = cl.version;
  dom.clTitle.value = cl.title;
  dom.clSummary.value = cl.summary || "";
  dom.clContent.value = cl.content || "";
  dom.clType.value = cl.releaseType || "patch";
  dom.clTags.value = (cl.tags || []).join(", ");
  dom.clPublished.checked = cl.published;
  updateChangelogPreview();
  // Scroll to top
  document.querySelector("#tab-changelogs section").scrollTop = 0;
};

window.requestDeleteChangelog = (id) => {
  deleteTargetId = id;
  dom.deleteConfirmModal.style.display = "flex";
};

const confirmDeleteChangelog = async () => {
  if (!deleteTargetId) return;
  const btn = dom.confirmDeleteBtn;
  btn.textContent = "Deleting...";
  btn.disabled = true;
  try {
    await deleteDoc(doc(db, "changelogs", deleteTargetId));
    changelogs = changelogs.filter(c => c.id !== deleteTargetId);
    renderChangelogHistory();
    if (dom.clIdInput.value === deleteTargetId) clearChangelogForm();
    showToast("Changelog deleted successfully.");
  } catch (err) {
    console.error("Delete error", err);
    showToast("Failed to delete changelog", "error");
  } finally {
    btn.textContent = "Delete";
    btn.disabled = false;
    dom.deleteConfirmModal.style.display = "none";
    deleteTargetId = null;
  }
};

const handleChangelogSubmit = async (e) => {
  e.preventDefault();
  const btn = dom.clSaveBtn;
  
  if (!dom.clVersion.value.trim() || !dom.clTitle.value.trim() || !dom.clContent.value.trim()) {
    dom.clErrorMsg.textContent = "Version, Title, and Content are required.";
    return;
  }
  dom.clErrorMsg.textContent = "";
  
  btn.disabled = true;
  btn.innerHTML = `<span>Saving...</span>`;
  
  const id = dom.clIdInput.value || Date.now().toString(); // Use timestamp as simple ID
  const tags = dom.clTags.value.split(",").map(t => t.trim()).filter(Boolean);
  
  const payload = {
    version: dom.clVersion.value.trim(),
    title: dom.clTitle.value.trim(),
    summary: dom.clSummary.value.trim(),
    content: dom.clContent.value.trim(),
    releaseType: dom.clType.value,
    tags: tags,
    published: dom.clPublished.checked,
    updatedAt: serverTimestamp(),
  };

  if (!dom.clIdInput.value) {
    payload.createdAt = serverTimestamp();
    payload.author = auth.currentUser?.uid || "admin";
  }

  try {
    await setDoc(doc(db, "changelogs", id), payload, { merge: true });
    showToast("Changelog saved successfully!");
    
    // Broadcast notification
    if (dom.clNotify.checked && dom.clPublished.checked) {
      await sendAdminNotification({
        title: `StudyMate updated to ${payload.version} 🚀`,
        message: payload.title + " - " + payload.summary,
        type: "info"
      });
      showToast("Broadcast notification sent!");
    }
    
    clearChangelogForm();
    fetchChangelogHistory(); // Re-fetch to get real timestamps
  } catch (err) {
    console.error("Save error", err);
    dom.clErrorMsg.textContent = err.message || "Failed to save changelog.";
    showToast("Failed to save changelog", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg><span>Save Changelog</span>`;
  }
};

const migrateJsonToFirestore = async () => {
  const btn = dom.runMigrationBtn;
  if (!confirm("This will import existing releases from config/changelog.json into Firestore. Proceed?")) return;
  
  btn.disabled = true;
  btn.textContent = "Migrating...";
  try {
    const res = await fetch("config/changelog.json?t=" + Date.now());
    if (!res.ok) throw new Error("Failed to load JSON");
    const data = await res.json();
    const releases = data.releases || [];
    
    let count = 0;
    for (const r of releases) {
      // Check if version already exists
      if (changelogs.find(c => c.version === r.version)) continue;
      
      const markdownContent = `## Added\n${(r.sections?.added || []).map(i => "- " + i).join("\n")}\n\n## Improved\n${(r.sections?.improved || []).map(i => "- " + i).join("\n")}\n\n## Fixed\n${(r.sections?.fixed || []).map(i => "- " + i).join("\n")}`;
      
      const payload = {
        version: r.version,
        title: r.title || "Update",
        summary: "Legacy imported changelog",
        content: markdownContent.trim(),
        releaseType: r.type || "patch",
        tags: ["legacy"],
        published: true,
        createdAt: new Date(r.date),
        updatedAt: new Date(r.date)
      };
      await setDoc(doc(db, "changelogs", Date.now().toString() + count), payload);
      count++;
    }
    showToast(`Migrated ${count} changelogs.`);
    fetchChangelogHistory();
  } catch (err) {
    console.error("Migration error", err);
    showToast("Migration failed", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Migrate json";
  }
};

// ── Knowledge Base Management Logic ──────────────────────────────────────────

const kbDom = {
  form: document.getElementById("adminKbForm"),
  category: document.getElementById("kbCategory"),
  entryId: document.getElementById("kbEntryId"),
  question: document.getElementById("kbQuestion"),
  answer: document.getElementById("kbAnswer"),
  keywords: document.getElementById("kbKeywords"),
  verified: document.getElementById("kbVerified"),
  saveBtn: document.getElementById("saveKbBtn"),
  clearBtn: document.getElementById("clearKbBtn"),
  syncBtn: document.getElementById("syncKbBtn"),
  list: document.getElementById("kbEntriesList"),
};

let kbEntries = [];
const API_BASE_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? (window.location.port === "3000" || window.location.port === "5500" ? "http://localhost:3001" : "")
  : (window.location.hostname.includes("onrender.com") ? "" : "https://api.aadirishi.in");

const initKbSystem = () => {
  if (!kbDom.form) return;
  kbDom.form.addEventListener("submit", handleKbSubmit);
  kbDom.clearBtn.addEventListener("click", clearKbForm);
  kbDom.syncBtn.addEventListener("click", syncKbToFirestore);
  kbDom.category.addEventListener("change", fetchKbEntries);
  
  // Expose to window for inline onclicks
  window.editKbEntry = editKbEntry;
  window.deleteKbEntry = deleteKbEntry;

  fetchKbEntries();
};

const getAuthHeaders = async () => {
  if (!auth.currentUser) throw new Error("Not authenticated");
  const token = await auth.currentUser.getIdToken();
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  };
};

const fetchKbEntries = async () => {
  try {
    console.log("Loading Knowledge...");
    console.log(`[KB] Fetching entries from ${API_BASE_URL}/api/kb`);
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE_URL}/api/kb`, { headers });
    
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server returned ${res.status}: ${text.substring(0, 100)}`);
    }

    const contentType = res.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error(`Expected JSON but received: ${contentType}`);
    }

    const data = await res.json();
    console.log("[KB] Successfully loaded knowledge entries");
    
    // Flatten entries for easy rendering and searching
    kbEntries = [];
    if (Array.isArray(data)) {
      data.forEach(cat => {
        if (cat && Array.isArray(cat.entries)) {
          cat.entries.forEach(e => {
            kbEntries.push({ ...e, filename: cat.filename });
          });
        }
      });
    }
    
    renderKbEntries();
  } catch(e) {
    console.error("[KB] Failed to fetch KB", e);
    kbDom.list.innerHTML = `<div style="text-align:center; color: #e74c3c;">Failed to load KB: ${escapeHtml(e.message)}</div>`;
  }
};

const renderKbEntries = () => {
  const currentCategory = kbDom.category.value;
  const filtered = Array.isArray(kbEntries) ? kbEntries.filter(e => e.filename === currentCategory) : [];

  if (filtered.length === 0) {
    kbDom.list.innerHTML = `<div style="text-align:center; color: var(--text-soft); padding: 20px;">No Knowledge Entries Found</div>`;
    console.log("UI Render Complete");
    return;
  }

  kbDom.list.innerHTML = filtered.map(entry => `
    <div class="changelog-history-item" style="flex-direction: column; align-items: stretch; gap: 8px;">
      <div class="history-item-header" style="justify-content: space-between; display: flex;">
        <span class="history-item-title" style="font-size: 1rem;">${escapeHtml(entry.question)}</span>
        <div style="display: flex; gap: 8px; align-items: center;">
          ${entry.verified ? '<span class="release-badge" style="background: rgba(46, 204, 113, 0.2); color: #2ecc71;">Verified</span>' : '<span class="release-badge" style="background: rgba(231, 76, 60, 0.2); color: #e74c3c;">Unverified</span>'}
          <span class="release-badge patch" style="background: rgba(155,89,182,0.2); color: #9b59b6;">${escapeHtml(entry.id)}</span>
        </div>
      </div>
      <div style="font-size: 0.85rem; color: var(--text-soft); line-height: 1.4;">
        ${escapeHtml((entry.answer || "").slice(0, 100))}${(entry.answer || "").length > 100 ? '...' : ''}
      </div>
      <div class="history-item-actions" style="margin-top: 8px;">
        <button type="button" class="history-btn" onclick="window.editKbEntry('${entry.id}')">Edit</button>
        <button type="button" class="history-btn delete" onclick="window.deleteKbEntry('${entry.filename}', '${entry.id}')">Delete</button>
      </div>
    </div>
  `).join("");
  
  console.log("UI Render Complete");
};

const clearKbForm = () => {
  kbDom.form.reset();
  kbDom.entryId.readOnly = false;
  if(kbDom.verified) kbDom.verified.checked = false;
};

const editKbEntry = (id) => {
  const entry = kbEntries.find(e => e.id === id);
  if (!entry) return;

  kbDom.category.value = entry.filename;
  kbDom.entryId.value = entry.id;
  kbDom.question.value = entry.question;
  kbDom.answer.value = entry.answer;
  kbDom.keywords.value = (entry.keywords || []).join(", ");
  if (kbDom.verified) kbDom.verified.checked = !!entry.verified;
  
  kbDom.entryId.readOnly = true;
  
  document.querySelector("#tab-knowledge section").scrollTop = 0;
};

const handleKbSubmit = async (e) => {
  e.preventDefault();
  
  const payload = {
    filename: kbDom.category.value,
    entry: {
      id: kbDom.entryId.value.trim(),
      question: kbDom.question.value.trim(),
      answer: kbDom.answer.value.trim(),
      keywords: kbDom.keywords.value.split(",").map(k => k.trim()).filter(Boolean),
      verified: kbDom.verified ? kbDom.verified.checked : false
    }
  };

  kbDom.saveBtn.disabled = true;
  kbDom.saveBtn.innerHTML = `<span>Saving...</span>`;

  try {
    console.log(`[KB] Saving entry to ${API_BASE_URL}/api/kb/entry`);
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE_URL}/api/kb/entry`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error(`Failed to save entry: ${errTxt}`);
    }
    
    showToast("KB Entry saved successfully!");
    clearKbForm();
    await fetchKbEntries();
  } catch(err) {
    console.error("[KB] Error saving entry:", err);
    showToast(`Error saving KB entry: ${err.message}`, "error");
  } finally {
    kbDom.saveBtn.disabled = false;
    kbDom.saveBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg><span>Save Entry</span>`;
  }
};

const deleteKbEntry = async (filename, id) => {
  if (!confirm(`Are you sure you want to delete KB entry: ${id}?`)) return;

  try {
    console.log(`[KB] Deleting entry ${id} from ${API_BASE_URL}/api/kb/entry`);
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE_URL}/api/kb/entry`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ filename, id })
    });
    
    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error(`Failed to delete entry: ${errTxt}`);
    }
    
    showToast("KB Entry deleted!");
    if (kbDom.entryId.value === id) clearKbForm();
    await fetchKbEntries();
  } catch(err) {
    console.error("[KB] Error deleting entry:", err);
    showToast(`Error deleting KB entry: ${err.message}`, "error");
  }
};

const syncKbToFirestore = async () => {
  kbDom.syncBtn.disabled = true;
  kbDom.syncBtn.textContent = "Syncing...";
  console.log("[KB] Firestore Sync Started");

  try {
    const headers = await getAuthHeaders();
    const res = await fetch(`${API_BASE_URL}/api/kb/sync`, {
      method: "POST",
      headers
    });
    
    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error(`Failed to sync: ${errTxt}`);
    }

    const data = await res.json();
    console.log(`[KB] Firestore Sync Success: ${data.count} entries`);
    showToast(`Synced ${data.count} entries to Firestore!`, "success");
    await fetchKbEntries();
  } catch(err) {
    console.error("[KB] Firestore Sync Failed:", err);
    showToast(`Sync failed: ${err.message}`, "error");
  } finally {
    kbDom.syncBtn.disabled = false;
    kbDom.syncBtn.textContent = "Sync to Firestore";
  }
};

// ── Startup ──────────────────────────────────────────────────────────────────
initAuth();

