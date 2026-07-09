import { db } from "./firebase.js";
import { collection, query, orderBy, limit, getDocs, startAfter, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { LEGAL_CONFIG } from "./config/legalConfig.js";

const logsState = {
  unsubscribeLogs: null,
  unsubscribeStats: null,
  pageLimit: 50,
  lastVisible: null,
  logs: [],
  page: 1,
  pageSize: 50,
  hasMore: true,
  loading: false,
  filters: {
    search: "",
    method: "all",
    version: "all",
    status: "all"
  }
};

const dom = {
  tableBody: document.getElementById("logsTableBody"),
  prevBtn: document.getElementById("logsPrevBtn"),
  nextBtn: document.getElementById("logsNextBtn"),
  pageIndicator: document.getElementById("logsPageIndicator"),
  searchInput: document.getElementById("logSearchInput"),
  methodFilter: document.getElementById("logMethodFilter"),
  versionFilter: document.getElementById("logVersionFilter"),
  statusFilter: document.getElementById("logStatusFilter"),
  refreshBtn: document.getElementById("refreshLogsBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  
  // Stats
  statTotal: document.getElementById("statTotalUsers"),
  statToday: document.getElementById("statTodaySignups"),
  statWeek: document.getElementById("statWeekSignups"),
  statMonth: document.getElementById("statMonthSignups"),
  statAccepted: document.getElementById("statAccepted"),
  statLegacy: document.getElementById("statLegacy"),
  statGoogle: document.getElementById("statGoogle"),
  statEmail: document.getElementById("statEmail"),

  // Modal
  modal: document.getElementById("logDetailModal"),
  modalContent: document.getElementById("logDetailContent"),
  closeModalBtn: document.getElementById("closeLogModalBtn")
};

export function initSignupLogs() {
  if (!dom.tableBody) return;

  dom.refreshBtn.addEventListener("click", () => {
    resetPagination();
    fetchLogs();
  });
  
  dom.searchInput.addEventListener("input", debounce(() => {
    logsState.filters.search = dom.searchInput.value.toLowerCase().trim();
    renderLogs(); // Client-side search for now due to Firestore limits
  }, 300));

  dom.methodFilter.addEventListener("change", (e) => {
    logsState.filters.method = e.target.value;
    resetPagination();
    fetchLogs();
  });

  dom.versionFilter.addEventListener("change", (e) => {
    logsState.filters.version = e.target.value;
    resetPagination();
    fetchLogs();
  });

  if (dom.statusFilter) {
    dom.statusFilter.addEventListener("change", (e) => {
      logsState.filters.status = e.target.value;
      resetPagination();
      fetchLogs();
    });
  }

  dom.prevBtn.addEventListener("click", () => {
    if (logsState.page > 1) {
      logsState.page--;
      renderLogs();
    }
  });

  dom.nextBtn.addEventListener("click", () => {
    if (logsState.page * logsState.pageSize < logsState.logs.length) {
      logsState.page++;
      renderLogs();
    } else if (logsState.hasMore) {
      fetchLogs(true);
    }
  });

  dom.exportCsvBtn.addEventListener("click", exportCsv);
  dom.exportJsonBtn.addEventListener("click", exportJson);
  dom.closeModalBtn.addEventListener("click", () => dom.modal.classList.remove("show"));

  // Initial fetch
  fetchLogs();
  fetchStats();
}

function resetPagination() {
  logsState.lastVisible = null;
  logsState.logs = [];
  logsState.page = 1;
  logsState.pageLimit = logsState.pageSize;
  logsState.hasMore = true;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

async function fetchLogs(loadMore = false) {
  if (logsState.loading || (!logsState.hasMore && loadMore)) return;
  logsState.loading = true;
  
  try {
    if (loadMore) {
      logsState.pageLimit += logsState.pageSize;
      logsState.page++;
    }

    if (logsState.unsubscribeLogs) {
      logsState.unsubscribeLogs();
    }

    const logsRef = collection(db, "users");
    let qArgs = [logsRef, orderBy("createdAt", "desc"), limit(logsState.pageLimit)];

    if (logsState.filters.method !== "all" && logsState.filters.method !== "legacy") {
      qArgs = [logsRef, where("provider", "==", logsState.filters.method), orderBy("createdAt", "desc"), limit(logsState.pageLimit)];
    }
    
    if (logsState.filters.version !== "all") {
      qArgs = [logsRef, where("agreementVersion", "==", logsState.filters.version), orderBy("createdAt", "desc"), limit(logsState.pageLimit)];
    }

    const q = query(...qArgs);
    
    logsState.unsubscribeLogs = onSnapshot(q, (snap) => {
      logsState.loading = false;
      if (snap.empty) {
        logsState.hasMore = false;
        if (!loadMore) logsState.logs = [];
      } else {
        logsState.logs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        logsState.hasMore = snap.docs.length === logsState.pageLimit;
      }
      renderLogs();
    }, (error) => {
      console.error("Error in onSnapshot for logs:", error);
      logsState.loading = false;
    });

  } catch (err) {
    console.error("Error fetching logs:", err);
    logsState.loading = false;
  }
}

function renderLogs() {
  dom.tableBody.innerHTML = "";
  
  let displayLogs = logsState.logs;
  
  const currentVersion = typeof LEGAL_CONFIG !== 'undefined' ? LEGAL_CONFIG.agreementVersion : "1.2.0";
  const isLegacyUser = (l) => !l.acceptedPrivacyPolicy || !l.acceptedTerms || l.agreementVersion !== currentVersion;
  const isDeletedUser = (l) => l.accountStatus === "deleted" || l.deleted === true;

  // Client-side filtering for search & legacy
  if (logsState.filters.search) {
    const s = logsState.filters.search;
    displayLogs = displayLogs.filter(l => 
      (l.displayName && l.displayName.toLowerCase().includes(s)) ||
      (l.email && l.email.toLowerCase().includes(s)) ||
      (l.uid && l.uid.toLowerCase().includes(s))
    );
  }
  
  if (logsState.filters.method === "legacy") {
    displayLogs = displayLogs.filter(l => isLegacyUser(l));
  }

  if (logsState.filters.status === "active") {
    displayLogs = displayLogs.filter(l => !isDeletedUser(l));
  } else if (logsState.filters.status === "deleted") {
    displayLogs = displayLogs.filter(l => isDeletedUser(l));
  }

  // Deduplicate by email (keeping the newest one since displayLogs is already sorted desc by createdAt)
  const seenEmails = new Set();
  const dedupedLogs = [];
  for (const log of displayLogs) {
    if (log.email) {
      if (!seenEmails.has(log.email)) {
        seenEmails.add(log.email);
        dedupedLogs.push(log);
      }
    } else {
      dedupedLogs.push(log); // Keep logs without email just in case
    }
  }
  displayLogs = dedupedLogs;

  // Client-side pagination over fetched data
  const startIndex = (logsState.page - 1) * logsState.pageSize;
  const pageLogs = displayLogs.slice(startIndex, startIndex + logsState.pageSize);

  if (pageLogs.length === 0) {
    dom.tableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-soft);">No logs found.</td></tr>`;
  } else {
    pageLogs.forEach(log => {
      const legacy = isLegacyUser(log);
      const deleted = isDeletedUser(log);
      const date = safeFormatDate(log.createdAt);
      
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
      
      tr.innerHTML = `
        <td style="padding: 12px 16px;">
          <div style="font-weight: 500;">${log.displayName || log.name || 'Unknown'}</div>
          <div style="font-size: 12px; color: var(--text-soft);">${log.email || 'No email'}</div>
        </td>
        <td style="padding: 12px 16px; font-size: 13px;">${date}</td>
        <td style="padding: 12px 16px;">
          <span style="background: rgba(255,255,255,0.1); padding: 2px 8px; border-radius: 12px; font-size: 11px; text-transform: uppercase;">
            ${log.provider || log.signupMethod || 'Unknown'}
          </span>
        </td>
        <td style="padding: 12px 16px;">
          ${legacy ? '<span style="color: #f39c12; font-size: 13px;">Legacy User</span>' : '<span style="color: #2ecc71; font-size: 13px;">✔ Accepted</span>'}
        </td>
        <td style="padding: 12px 16px; font-size: 13px;">
          ${deleted ? '<span style="background: #e74c3c; color: white; padding: 2px 8px; border-radius: 12px; font-weight: bold; font-size: 11px;">DELETED</span>' : (log.role === 'admin' ? '<span style="color: #e74c3c;">Admin</span>' : (log.isPremium ? '<span style="color: #f1c40f;">Premium</span>' : 'User'))}
        </td>
        <td style="padding: 12px 16px;">
          <button class="view-btn admin-send-btn" style="padding: 4px 8px; font-size: 11px;" data-id="${log.id}">View</button>
        </td>
      `;
      
      tr.querySelector('.view-btn').addEventListener('click', () => openModal(log));
      dom.tableBody.appendChild(tr);
    });
  }

  updatePaginationControls(displayLogs.length);
}

function updatePaginationControls(totalFiltered) {
  dom.pageIndicator.textContent = `Page ${logsState.page}`;
  dom.prevBtn.disabled = logsState.page === 1;
  
  const hasNextPageLocally = logsState.page * logsState.pageSize < totalFiltered;
  dom.nextBtn.disabled = !hasNextPageLocally && !logsState.hasMore;
}

function safeFormatDate(val) {
  if (!val) return "Unknown";
  if (typeof val.toDate === 'function') return val.toDate().toLocaleString();
  if (typeof val.toDateString === 'function') return val.toLocaleString();
  return new Date(val).toLocaleString();
}

function openModal(log) {
  const date = safeFormatDate(log.createdAt);
  const lastLogin = safeFormatDate(log.lastLogin);
  let content = `
    <p><strong>UID:</strong> ${log.uid}</p>
    <p><strong>Name:</strong> ${log.displayName || log.name || 'Unknown'}</p>
    <p><strong>Email:</strong> ${log.email || 'Unknown'} ${log.emailVerified ? '(<span style="color: #2ecc71;">Verified</span>)' : '(<span style="color: #e74c3c;">Unverified</span>)'}</p>
    <p><strong>Account Status:</strong> ${(log.accountStatus === 'deleted' || log.deleted) ? '<span style="color: #e74c3c; font-weight: bold;">Deleted</span>' : 'Active'}</p>
    <p><strong>Registration Date:</strong> ${date}</p>
    <p><strong>Last Login:</strong> ${lastLogin}</p>
    <p><strong>Auth Provider:</strong> ${log.provider || log.signupMethod || 'Unknown'}</p>
    <p><strong>Role:</strong> ${log.role || 'user'} ${log.isAdmin ? '(Admin Flag)' : ''}</p>
    <p><strong>Account Status:</strong> ${log.accountStatus || (log.isBlocked ? 'Blocked' : 'Active')}</p>
    <p><strong>Subscription:</strong> ${log.subscription || 'free'} (Plan: ${log.plan || 'free'})</p>
    <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 12px 0;">
  `;
  
  const currentVersion = typeof LEGAL_CONFIG !== 'undefined' ? LEGAL_CONFIG.agreementVersion : "1.2.0";
  const isLegacy = !log.acceptedPrivacyPolicy || !log.acceptedTerms || log.agreementVersion !== currentVersion;

  if (!isLegacy) {
    content += `
      <p><strong>Agreement Accepted:</strong> Yes</p>
      <p><strong>Terms Accepted:</strong> ${log.acceptedTerms ? 'Yes' : 'Unknown'}</p>
      <p><strong>Privacy Policy Accepted:</strong> ${log.acceptedPrivacyPolicy ? 'Yes' : 'Unknown'}</p>
      <p><strong>Agreement Version:</strong> ${log.agreementAcceptedVersion || log.agreementVersion || '1.0'}</p>
      <p><strong>Browser/UserAgent:</strong> ${log.agreementAcceptedUserAgent || log.userAgent || 'Unknown'}</p>
    `;
  } else {
    content += `<p><strong>Status:</strong> Legacy User (Signed up before Terms Tracking)</p>`;
  }
  
  dom.modalContent.innerHTML = content;
  dom.modal.classList.add("show");
}

async function fetchStats() {
  try {
    if (logsState.unsubscribeStats) {
      logsState.unsubscribeStats();
    }
    
    const logsRef = collection(db, "users");
    const q = query(logsRef, limit(1000));
    const currentVersion = typeof LEGAL_CONFIG !== 'undefined' ? LEGAL_CONFIG.agreementVersion : "1.2.0";
    
    logsState.unsubscribeStats = onSnapshot(q, (snap) => {
      let today = 0;
      let week = 0;
      let month = 0;
      let accepted = 0;
      let legacy = 0;
      let google = 0;
      let email = 0;

      const now = new Date();
      
      const seenStatsEmails = new Set();
      
      snap.docs.forEach(doc => {
        const data = doc.data();
        
        // Deduplicate stats by email to prevent orphaned accounts from inflating numbers
        if (data.email) {
          if (seenStatsEmails.has(data.email)) return;
          seenStatsEmails.add(data.email);
        }

        const isLegacy = !data.acceptedPrivacyPolicy || !data.acceptedTerms || data.agreementVersion !== currentVersion;
        if (isLegacy) legacy++;
        else accepted++;
        
        const provider = data.provider || data.signupMethod;
        if (provider === "google") google++;
        if (provider === "email") email++;

        if (data.createdAt) {
          let diffDays = -1;
          if (typeof data.createdAt.toDate === 'function') {
            const dt = data.createdAt.toDate();
            diffDays = (now - dt) / (1000 * 3600 * 24);
          } else if (data.createdAt.seconds) {
            const dt = new Date(data.createdAt.seconds * 1000);
            diffDays = (now - dt) / (1000 * 3600 * 24);
          } else if (typeof data.createdAt === 'string' || typeof data.createdAt === 'number') {
            const dt = new Date(data.createdAt);
            diffDays = (now - dt) / (1000 * 3600 * 24);
          }

          if (diffDays >= 0) {
            if (diffDays <= 1) today++;
            if (diffDays <= 7) week++;
            if (diffDays <= 30) month++;
          }
        }
      });

      if (dom.statTotal) dom.statTotal.textContent = accepted + legacy; // Use deduplicated total
      if (dom.statToday) dom.statToday.textContent = today;
      if (dom.statWeek) dom.statWeek.textContent = week;
      if (dom.statMonth) dom.statMonth.textContent = month;
      if (dom.statAccepted) dom.statAccepted.textContent = accepted;
      if (dom.statLegacy) dom.statLegacy.textContent = legacy;
      if (dom.statGoogle) dom.statGoogle.textContent = google;
      if (dom.statEmail) dom.statEmail.textContent = email;
    }, (error) => {
      console.error("Error in onSnapshot for stats:", error);
    });

  } catch (err) {
    console.error("Error setting up stats listener:", err);
  }
}

function exportCsv() {
  let csv = "UID,Name,Email,SignupDate,Method,AgreementAccepted,AgreementVersion,Role,Status,Premium\n";
  logsState.logs.forEach(log => {
    let dateStr = "";
    if (log.createdAt) {
      if (typeof log.createdAt.toDate === 'function') {
        dateStr = log.createdAt.toDate().toISOString();
      } else {
        dateStr = new Date(log.createdAt).toISOString();
      }
    }
    csv += `"${log.uid}","${log.displayName || log.name || ''}","${log.email || ''}","${dateStr}","${log.provider || log.signupMethod || ''}","${!!(log.agreementAccepted || log.acceptedTerms)}","${log.agreementAcceptedVersion || log.agreementVersion || ''}","${log.role || 'user'}","${log.accountStatus || 'active'}","${!!log.isPremium}"\n`;
  });
  
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = "signuplogs.csv";
  a.click();
}

function exportJson() {
  const data = JSON.stringify(logsState.logs, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = "signuplogs.json";
  a.click();
}
