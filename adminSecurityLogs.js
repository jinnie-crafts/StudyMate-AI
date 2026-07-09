import { db } from "./firebase.js";
import { collection, query, orderBy, limit, getDocs, onSnapshot, where, startAfter } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const state = {
  logs: [],
  filters: {
    search: "",
    severity: "all",
    threatLevel: "all"
  },
  lastVisible: null,
  pageSize: 20,
  hasMore: true,
  isLoading: false,
  
  // Dashboard stats
  totalBlocked24h: 0,
  criticalHighEvents: 0,
  categoryCounts: {},
  offenderCounts: {},
  
  // Reset Context
  resetTarget: null
};

const dom = {
  tableBody: document.getElementById("securityLogsTableBody"),
  searchInput: document.getElementById("securitySearch"),
  severityFilter: document.getElementById("securitySeverityFilter"),
  threatLevelFilter: document.getElementById("securityThreatLevelFilter"),
  refreshBtn: document.getElementById("refreshSecurityLogs"),
  prevBtn: document.getElementById("prevSecurityPage"),
  nextBtn: document.getElementById("nextSecurityPage"),
  pageInfo: document.getElementById("securityPageInfo"),
  
  statTotal: document.getElementById("secStatTotal"),
  statCritical: document.getElementById("secStatCritical"),
  statCategory: document.getElementById("secStatCategory"),
  statOffender: document.getElementById("secStatOffender"),
  
  // Modal
  resetModal: document.getElementById("adminSecurityResetModal"),
  resetUserId: document.getElementById("resetTargetUserId"),
  resetEmail: document.getElementById("resetTargetEmail"),
  resetReason: document.getElementById("resetReasonInput"),
  confirmResetBtn: document.getElementById("confirmResetBtn"),
  cancelResetBtn: document.getElementById("cancelResetBtn")
};

export function initSecurityLogs() {
  if (!dom.tableBody) return;

  setupEventListeners();
  loadDashboardStats();
  loadLogs(true);
}

function setupEventListeners() {
  dom.refreshBtn.addEventListener("click", () => {
    loadDashboardStats();
    loadLogs(true);
  });

  dom.searchInput.addEventListener("input", (e) => {
    state.filters.search = e.target.value.toLowerCase().trim();
    loadLogs(true);
  });

  dom.severityFilter.addEventListener("change", (e) => {
    state.filters.severity = e.target.value;
    loadLogs(true);
  });
  
  dom.threatLevelFilter.addEventListener("change", (e) => {
    state.filters.threatLevel = e.target.value;
    loadLogs(true);
  });

  dom.nextBtn.addEventListener("click", () => {
    if (state.hasMore && !state.isLoading) {
      loadLogs(false);
    }
  });

  dom.prevBtn.addEventListener("click", () => {
    loadLogs(true);
  });
  
  // Modal events
  dom.cancelResetBtn.addEventListener("click", closeResetModal);
  
  dom.confirmResetBtn.addEventListener("click", async () => {
    const reason = dom.resetReason.value.trim();
    if (!reason) {
      alert("Please provide a reason for the reset.");
      return;
    }
    
    dom.confirmResetBtn.disabled = true;
    dom.confirmResetBtn.textContent = "Resetting...";
    
    try {
      // We must get the ID token of the current admin user to call the API
      const { getAuth } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js");
      const auth = getAuth();
      if (!auth.currentUser) throw new Error("Not authenticated");
      
      const idToken = await auth.currentUser.getIdToken();
      
      const res = await fetch("/api/admin/security/reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${idToken}`
        },
        body: JSON.stringify({
          targetUserId: state.resetTarget.userId,
          targetEmail: state.resetTarget.email,
          previousScore: state.resetTarget.rollingThreatScore,
          previousLevel: state.resetTarget.threatLevel,
          reason: reason
        })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reset score");
      
      closeResetModal();
      loadDashboardStats();
      loadLogs(true); // reload logs to show the reset event
      
    } catch (err) {
      console.error(err);
      alert("Reset failed: " + err.message);
    } finally {
      dom.confirmResetBtn.disabled = false;
      dom.confirmResetBtn.textContent = "Confirm Reset";
    }
  });
}

function openResetModal(logData) {
  state.resetTarget = logData;
  dom.resetUserId.value = logData.userId || 'Anonymous';
  dom.resetEmail.value = logData.email || 'N/A';
  dom.resetReason.value = "";
  dom.resetModal.style.display = "flex";
}

function closeResetModal() {
  state.resetTarget = null;
  dom.resetModal.style.display = "none";
}

// Attach to window so onclick handlers in the HTML template can use it
window.openSecurityResetModal = function(logIdx) {
  const log = state.logs[logIdx];
  if (log) openResetModal(log);
};

async function loadDashboardStats() {
  const yesterday = new Date();
  yesterday.setHours(yesterday.getHours() - 24);

  try {
    const logsRef = collection(db, "security_logs");
    const q = query(logsRef, where("timestamp", ">=", yesterday));
    const snapshot = await getDocs(q);

    state.totalBlocked24h = 0;
    state.criticalHighEvents = 0;
    state.categoryCounts = {};
    state.offenderCounts = {};

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.eventType === "admin_reset") return; // skip resets in threat stats
      
      const count = data.attemptCount || 1;
      state.totalBlocked24h += count;
      
      if (data.severity === 'critical' || data.severity === 'high') {
        state.criticalHighEvents += count;
      }

      if (data.detectedIntent) {
        state.categoryCounts[data.detectedIntent] = (state.categoryCounts[data.detectedIntent] || 0) + count;
      }

      const uid = data.email || data.userId || 'Anonymous';
      state.offenderCounts[uid] = (state.offenderCounts[uid] || 0) + count;
    });

    let topCategory = 'N/A';
    let maxCat = 0;
    for (const [cat, count] of Object.entries(state.categoryCounts)) {
      if (count > maxCat) {
        maxCat = count;
        topCategory = cat;
      }
    }

    let topOffender = 'N/A';
    let maxOff = 0;
    for (const [off, count] of Object.entries(state.offenderCounts)) {
      if (count > maxOff) {
        maxOff = count;
        topOffender = off;
      }
    }

    dom.statTotal.textContent = state.totalBlocked24h;
    dom.statCritical.textContent = state.criticalHighEvents;
    dom.statCategory.textContent = topCategory;
    dom.statCategory.title = topCategory;
    dom.statOffender.textContent = topOffender;
    dom.statOffender.title = topOffender;

  } catch (err) {
    console.error("Failed to load dashboard stats:", err);
  }
}

async function loadLogs(reset = false) {
  if (state.isLoading) return;
  state.isLoading = true;

  if (reset) {
    state.lastVisible = null;
    state.logs = [];
    state.hasMore = true;
    dom.tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px;">Loading logs...</td></tr>`;
  }

  try {
    const logsRef = collection(db, "security_logs");
    let queryConstraints = [];

    if (state.filters.severity !== "all") {
      queryConstraints.push(where("severity", "==", state.filters.severity));
    }
    if (state.filters.threatLevel !== "all") {
      queryConstraints.push(where("threatLevel", "==", state.filters.threatLevel));
    }

    queryConstraints.push(orderBy("timestamp", "desc"));

    if (state.lastVisible && !reset) {
      queryConstraints.push(startAfter(state.lastVisible));
    }

    const fetchLimit = state.filters.search ? 100 : state.pageSize;
    queryConstraints.push(limit(fetchLimit));

    const q = query(logsRef, ...queryConstraints);
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      state.hasMore = false;
      if (reset) {
        dom.tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-muted);">No security events found.</td></tr>`;
      }
    } else {
      state.lastVisible = snapshot.docs[snapshot.docs.length - 1];
      state.hasMore = snapshot.docs.length === fetchLimit;
      
      const newLogs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      if (reset) {
        state.logs = newLogs;
      } else {
        state.logs = [...state.logs, ...newLogs];
      }
      
      renderTable();
    }
  } catch (error) {
    console.error("Error fetching security logs:", error);
    if (reset) {
      dom.tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #e74c3c; padding: 24px;">Failed to load logs. Missing Index or Permission Denied.</td></tr>`;
    }
  } finally {
    state.isLoading = false;
    dom.nextBtn.disabled = !state.hasMore;
    dom.prevBtn.disabled = state.lastVisible === null;
  }
}

function renderTable() {
  let displayLogs = state.logs;
  
  if (state.filters.search) {
    const s = state.filters.search;
    displayLogs = displayLogs.filter(log => {
      return (log.email || "").toLowerCase().includes(s) ||
             (log.userId || "").toLowerCase().includes(s) ||
             (log.prompt || "").toLowerCase().includes(s);
    });
  }

  const pageLogs = displayLogs.slice(0, state.pageSize);

  dom.tableBody.innerHTML = "";

  if (pageLogs.length === 0) {
    dom.tableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-muted);">No logs match search criteria.</td></tr>`;
    return;
  }

  pageLogs.forEach((log, index) => {
    const tr = document.createElement("tr");
    
    const date = log.timestamp ? log.timestamp.toDate() : new Date();
    const dateStr = date.toLocaleString('en-US', { 
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
    });

    if (log.eventType === "admin_reset") {
      tr.innerHTML = `
        <td style="white-space: nowrap; font-size: 13px; color: #3498db;">${dateStr}</td>
        <td>
          <div style="font-weight: 500; color: #3498db;">ADMIN OVERRIDE</div>
          <div style="font-size: 12px; color: var(--text-muted);">By: ${escapeHtml(log.adminEmail || log.adminUid)}</div>
        </td>
        <td><span style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; background: #3498db20; color: #3498db;">RESET TO 0</span></td>
        <td colspan="2">
          <div style="font-size: 13px; color: var(--text-muted);">Target: ${escapeHtml(log.targetEmail || log.targetUserId)}</div>
          <div style="font-size: 12px; margin-top: 4px;">Reason: ${escapeHtml(log.reason)}</div>
        </td>
        <td colspan="2"></td>
      `;
      dom.tableBody.appendChild(tr);
      return;
    }

    let severityColor = "var(--text-muted)";
    if (log.severity === 'critical') severityColor = "#e74c3c";
    else if (log.severity === 'high') severityColor = "#e67e22";
    else if (log.severity === 'medium') severityColor = "#f1c40f";
    
    let threatColor = "var(--text-muted)";
    if (log.threatLevel === 'critical') threatColor = "#e74c3c";
    else if (log.threatLevel === 'high') threatColor = "#e67e22";
    else if (log.threatLevel === 'medium') threatColor = "#f1c40f";

    const intentBadge = `<span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; background: ${severityColor}20; color: ${severityColor}; text-transform: uppercase;">${log.severity || 'N/A'}</span>`;
    const threatBadge = `<span style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; background: ${threatColor}20; color: ${threatColor}; text-transform: uppercase;">SCORE: ${log.rollingThreatScore || 0}</span>`;
    const deferredBadge = log.suspensionDeferred ? `<div style="margin-top: 4px;"><span style="font-size: 10px; background: #9b59b6; color: white; padding: 2px 4px; border-radius: 4px;">Suspension Deferred</span></div>` : "";
    
    const countBadge = log.attemptCount > 1 
      ? `<span style="margin-left: 8px; background: #3498db; color: white; padding: 2px 6px; border-radius: 12px; font-size: 10px; font-weight: bold;">x${log.attemptCount}</span>` 
      : '';

    tr.innerHTML = `
      <td style="white-space: nowrap; font-size: 13px; color: var(--text-muted);">${dateStr}</td>
      <td>
        <div style="font-weight: 500;">${escapeHtml(log.displayName || 'Anonymous')}</div>
        <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(log.email || log.userId || 'N/A')}</div>
      </td>
      <td>
        ${threatBadge}
        ${deferredBadge}
      </td>
      <td>
        <div style="font-size: 13px;">${escapeHtml(log.detectedIntent || 'N/A')}</div>
        <div style="margin-top: 4px;">${intentBadge}</div>
      </td>
      <td>
        <span style="font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
          ${escapeHtml(log.blockedBy || 'SecurityAgent')}
        </span>
      </td>
      <td style="max-width: 250px;">
        <div style="display: flex; align-items: center;">
          <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; font-family: monospace; background: rgba(255,255,255,0.05); padding: 4px 8px; border-radius: 4px;" title="${escapeHtml(log.prompt || '')}">
            ${escapeHtml(log.prompt || '')}
          </div>
          ${countBadge}
        </div>
      </td>
      <td>
        <button class="admin-secondary-btn" style="font-size: 11px; padding: 4px 8px;" onclick="window.openSecurityResetModal(${index})">Reset</button>
      </td>
    `;
    dom.tableBody.appendChild(tr);
  });
}

function escapeHtml(unsafe) {
  return String(unsafe)
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;");
}
