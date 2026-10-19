/**
 * StudyMate AI — Seamless SPA Navigation & View Caching System
 * 
 * Provides client-side routing, Stale-While-Revalidate HTML caching,
 * scroll & input draft preservation, History API integration, and
 * zero-reload page transitions between Dashboard, Settings, Terms, and Privacy.
 */

class SPANavigationManager {
  constructor() {
    this.routes = new Set(["/", "/index.html", "/settings", "/settings.html", "/terms", "/terms.html", "/privacy", "/privacy.html", "/changelog"]);
    this.viewCache = new Map(); // url -> { html, title, dataPage, bodyClass, timestamp }
    this.stateCache = new Map(); // url -> { scrollTop, draftInput, activeSection }
    this.CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    this.isNavigating = false;
    this.progressBar = null;
    this.containerEl = null;

    // Callbacks provided by host app
    this.onNavigateHooks = [];
    this.activeUser = null;
  }

  /**
   * Initialize the SPA navigation system
   */
  init(options = {}) {
    if (this._initialized) return;
    this._initialized = true;

    this.createProgressBar();
    this.setupLinkInterceptor();
    this.setupHistoryListener();

    // Cache initial page content
    const currentPath = this.normalizePath(window.location.pathname);
    this.cacheCurrentPage(currentPath);

    console.log("[SPANavigation] Initialized for route:", currentPath);
  }

  setUser(user) {
    this.activeUser = user;
  }

  /**
   * Register a navigation lifecycle hook
   */
  onNavigate(hook) {
    if (typeof hook === "function") {
      this.onNavigateHooks.push(hook);
    }
  }

  createProgressBar() {
    if (document.getElementById("spaProgressBar")) return;
    const bar = document.createElement("div");
    bar.id = "spaProgressBar";
    bar.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      height: 2.5px;
      width: 0%;
      background: linear-gradient(90deg, #7c3aed, #ec4899, #38bdf8);
      z-index: 999999;
      pointer-events: none;
      transition: width 0.25s ease, opacity 0.3s ease;
      opacity: 0;
      box-shadow: 0 0 10px rgba(124, 58, 237, 0.6);
    `;
    document.body.appendChild(bar);
    this.progressBar = bar;
  }

  startProgress() {
    if (!this.progressBar) return;
    this.progressBar.style.opacity = "1";
    this.progressBar.style.width = "40%";
  }

  finishProgress() {
    if (!this.progressBar) return;
    this.progressBar.style.width = "100%";
    setTimeout(() => {
      this.progressBar.style.opacity = "0";
      setTimeout(() => {
        if (this.progressBar) this.progressBar.style.width = "0%";
      }, 300);
    }, 150);
  }

  normalizePath(pathname) {
    let clean = pathname || "/";
    if (clean.length > 1 && clean.endsWith("/")) {
      clean = clean.slice(0, -1);
    }
    if (clean.endsWith(".html") && clean !== "/index.html") {
      clean = clean.slice(0, -5);
    }
    if (clean === "/index.html") clean = "/";
    return clean || "/";
  }

  isEligibleRoute(pathname) {
    const clean = this.normalizePath(pathname);
    // Explicitly exclude auth pages, admin, and assets
    if (
      clean.startsWith("/login") ||
      clean.startsWith("/signup") ||
      clean.startsWith("/verify") ||
      clean.startsWith("/reset") ||
      clean.startsWith("/recover") ||
      clean.startsWith("/admin") ||
      clean.startsWith("/api/") ||
      clean.startsWith("/img/")
    ) {
      return false;
    }

    return clean === "/" || clean === "/settings" || clean === "/terms" || clean === "/privacy" || clean === "/changelog";
  }

  setupLinkInterceptor() {
    document.addEventListener("click", (e) => {
      // Find closest anchor tag
      const anchor = e.target.closest("a");
      if (!anchor) return;

      // Skip if explicitly marked or modified click (Ctrl/Cmd/middle click)
      if (anchor.dataset.noSpa === "true" || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
        return;
      }

      // Skip external links or downloads
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:") || anchor.hasAttribute("download")) {
        return;
      }

      try {
        const url = new URL(href, window.location.origin);
        if (url.origin !== window.location.origin) return; // External link

        const targetPath = this.normalizePath(url.pathname);
        if (this.isEligibleRoute(targetPath)) {
          e.preventDefault();
          this.navigateTo(url.pathname + url.search + url.hash);
        }
      } catch (err) {
        // Fall back to default browser navigation on parse failure
      }
    });
  }

  setupHistoryListener() {
    window.addEventListener("popstate", (e) => {
      const targetPath = this.normalizePath(window.location.pathname);
      console.log("[SPANavigation] popstate to:", targetPath);
      this.renderRoute(targetPath, false);
    });
  }

  cacheCurrentPage(route) {
    const content = this.captureCurrentViewContent();
    if (content) {
      this.viewCache.set(route, {
        html: content,
        title: document.title,
        dataPage: document.body.dataset.page || "dashboard",
        bodyClass: document.body.className || "app-page",
        timestamp: Date.now()
      });
    }
  }

  captureCurrentViewContent() {
    const page = document.body.dataset.page;
    if (page === "dashboard") {
      const appEl = document.getElementById("app") || document.querySelector(".app-container");
      return appEl ? appEl.outerHTML : document.body.innerHTML;
    } else if (page === "settings") {
      const settingsEl = document.querySelector(".settings-shell");
      return settingsEl ? settingsEl.outerHTML : document.body.innerHTML;
    } else {
      const legalEl = document.querySelector(".legal-container");
      return legalEl ? legalEl.outerHTML : document.body.innerHTML;
    }
  }

  saveTransientState(route) {
    const stateObj = {};
    const chatMsg = document.getElementById("chatMessages");
    if (chatMsg) {
      stateObj.scrollTop = chatMsg.scrollTop;
    }
    const userInput = document.getElementById("userInput");
    if (userInput) {
      stateObj.draftInput = userInput.value;
    }
    const activeSettingsNav = document.querySelector("#settingsNav .nav-item.active");
    if (activeSettingsNav) {
      stateObj.activeSection = activeSettingsNav.dataset.section;
    }
    this.stateCache.set(route, stateObj);
  }

  restoreTransientState(route) {
    const stateObj = this.stateCache.get(route);
    if (!stateObj) return;

    if (stateObj.scrollTop !== undefined) {
      const chatMsg = document.getElementById("chatMessages");
      if (chatMsg) {
        requestAnimationFrame(() => { chatMsg.scrollTop = stateObj.scrollTop; });
      }
    }
    if (stateObj.draftInput !== undefined) {
      const userInput = document.getElementById("userInput");
      if (userInput && !userInput.value) {
        userInput.value = stateObj.draftInput;
      }
    }
    if (stateObj.activeSection) {
      const targetNav = document.querySelector(`#settingsNav .nav-item[data-section="${stateObj.activeSection}"]`);
      if (targetNav) targetNav.click();
    }
  }

  /**
   * Programmatic navigation API
   */
  async navigateTo(urlStr) {
    if (this.isNavigating) return;
    const url = new URL(urlStr, window.location.origin);
    const targetPath = this.normalizePath(url.pathname);
    const currentPath = this.normalizePath(window.location.pathname);

    if (targetPath === currentPath && url.search === window.location.search && !url.hash) {
      return; // Already here
    }

    // Save current transient state
    this.saveTransientState(currentPath);

    // Update history
    window.history.pushState({ path: targetPath }, "", urlStr);

    await this.renderRoute(targetPath, true);
  }

  async renderRoute(targetPath, isPush = true) {
    this.isNavigating = true;
    this.startProgress();

    try {
      // 1. Check in-memory view cache
      const cached = this.viewCache.get(targetPath);
      const isFresh = cached && (Date.now() - cached.timestamp < this.CACHE_TTL_MS);

      if (cached) {
        // Render cached view immediately
        this.mountView(targetPath, cached);
        // If stale, fetch fresh view in background
        if (!isFresh) {
          this.fetchAndCacheView(targetPath, false);
        }
        return;
      }

      // 2. Fetch view from server
      const freshView = await this.fetchAndCacheView(targetPath, true);
      if (freshView) {
        this.mountView(targetPath, freshView);
      } else {
        // Fallback to normal navigation if fetch failed
        window.location.href = targetPath;
      }
    } catch (err) {
      console.error("[SPANavigation] Error rendering route:", err);
      window.location.href = targetPath;
    } finally {
      this.finishProgress();
      this.isNavigating = false;
    }
  }

  async fetchAndCacheView(targetPath, mountAfter = false) {
    try {
      const fetchUrl = targetPath === "/" ? "/index.html" : targetPath;
      let res = await fetch(fetchUrl, {
        headers: { "X-Requested-With": "StudyMateSPA" }
      });

      // Fallback for static servers without clean URL rewrites: try .html
      if (!res.ok && !fetchUrl.endsWith(".html")) {
        res = await fetch(`${fetchUrl}.html`, {
          headers: { "X-Requested-With": "StudyMateSPA" }
        });
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const htmlText = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, "text/html");

      const title = doc.title || "StudyMate AI";
      let dataPage = doc.body.dataset.page;
      if (!dataPage) {
        if (targetPath.includes("settings")) {
          dataPage = "settings";
        } else if (targetPath.includes("terms") || targetPath.includes("privacy") || doc.querySelector(".legal-container")) {
          dataPage = "legal";
        } else {
          dataPage = "dashboard";
        }
      }
      const bodyClass = doc.body.className || (dataPage === "settings" ? "settings-page" : (dataPage === "legal" ? "legal-page" : "app-page"));

      let contentHtml = "";
      if (dataPage === "dashboard") {
        const app = doc.getElementById("app") || doc.querySelector(".app-container");
        contentHtml = app ? app.outerHTML : doc.body.innerHTML;
      } else if (dataPage === "settings") {
        const shell = doc.querySelector(".settings-shell");
        contentHtml = shell ? shell.outerHTML : doc.body.innerHTML;
      } else {
        const legal = doc.querySelector(".legal-container");
        contentHtml = legal ? legal.outerHTML : doc.body.innerHTML;
      }

      const viewRecord = {
        html: contentHtml,
        title,
        dataPage,
        bodyClass,
        timestamp: Date.now()
      };

      this.viewCache.set(targetPath, viewRecord);

      if (mountAfter) {
        return viewRecord;
      }
    } catch (e) {
      console.warn("[SPANavigation] Background fetch failed for:", targetPath, e.message);
      return null;
    }
  }

  mountView(targetPath, viewRecord) {
    // 1. Update Title and Body Metadata
    document.title = viewRecord.title;
    document.body.dataset.page = viewRecord.dataPage;
    document.body.className = viewRecord.bodyClass;

    // 2. Identify native and persistent mounts
    const existingApp = document.getElementById("app") || document.querySelector(".app-container");
    const nativeSettings = document.querySelector("body > .settings-shell");
    let settingsMount = document.getElementById("spaSettingsMount");
    let legalMount = document.getElementById("spaLegalMount");

    if (viewRecord.dataPage === "dashboard") {
      if (nativeSettings) nativeSettings.style.display = "none";
      if (settingsMount) settingsMount.style.display = "none";
      if (legalMount) legalMount.style.display = "none";

      if (existingApp) {
        existingApp.style.display = "";
      }
    } else if (viewRecord.dataPage === "settings") {
      if (existingApp) existingApp.style.display = "none";
      if (legalMount) legalMount.style.display = "none";

      if (nativeSettings) {
        nativeSettings.style.display = "";
      } else {
        if (!settingsMount) {
          settingsMount = document.createElement("div");
          settingsMount.id = "spaSettingsMount";
          settingsMount.innerHTML = viewRecord.html;
          document.body.appendChild(settingsMount);
        } else {
          settingsMount.style.display = "";
          settingsMount.innerHTML = viewRecord.html;
        }
      }
    } else {
      // Legal or other pages
      if (existingApp) existingApp.style.display = "none";
      if (nativeSettings) nativeSettings.style.display = "none";
      if (settingsMount) settingsMount.style.display = "none";

      if (!legalMount) {
        legalMount = document.createElement("div");
        legalMount.id = "spaLegalMount";
        document.body.appendChild(legalMount);
      }
      legalMount.style.display = "";
      legalMount.innerHTML = viewRecord.html;

      // Bind back button navigation
      const backBtn = legalMount.querySelector("#backBtn") || legalMount.querySelector(".back-link");
      if (backBtn) {
        backBtn.onclick = (e) => {
          e.preventDefault();
          if (window.history.length > 1) {
            window.history.back();
          } else {
            this.navigateTo("/");
          }
        };
      }
    }

    // 3. Scroll to top on fresh page load or restore transient state
    window.scrollTo({ top: 0, behavior: "auto" });
    this.restoreTransientState(targetPath);

    // 4. Trigger lifecycle hooks
    this.onNavigateHooks.forEach(hook => {
      try {
        hook(targetPath, viewRecord.dataPage);
      } catch (err) {
        console.error("[SPANavigation] Hook error:", err);
      }
    });

    console.log(`[SPANavigation] Successfully transitioned to: ${targetPath} (${viewRecord.dataPage})`);
  }

  /**
   * Invalidate all user-specific and rendered caches on logout
   */
  clearUserCaches() {
    this.viewCache.clear();
    this.stateCache.clear();
    const settingsMount = document.getElementById("spaSettingsMount");
    if (settingsMount) settingsMount.remove();
    const legalMount = document.getElementById("spaLegalMount");
    if (legalMount) legalMount.remove();
    console.log("[SPANavigation] Cleared view and state caches for user isolation.");
  }
}

export const spaNavigation = new SPANavigationManager();
export default spaNavigation;
