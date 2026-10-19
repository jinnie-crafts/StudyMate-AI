/**
 * StudyMate AI — Centralized Admin Authentication & Request Lifecycle Helper
 * 
 * Provides:
 * - Session-aware Firebase ID token acquisition
 * - Coordinated deduplication of concurrent token refreshes
 * - Bounded 401 retry: refreshes token and retries ONCE, then halts
 * - Non-retryable 403 (Forbidden) handling for non-admin users
 * - Respect for 429 Rate Limiting with Retry-After header
 * - Inflight request deduplication for concurrent GETs (avoids duplicate network calls)
 * - Automatic cache cleanup on authentication state changes (logout/login)
 */

import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

let inflightTokenRefreshPromise = null;
const inflightGetRequests = new Map(); // key: fullUrl -> Promise<Response>

/**
 * Determine API base URL dynamically based on environment
 */
export function getApiBaseUrl() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return window.location.port === "3001" ? "" : `http://${host}:3001`;
  }
  return host.includes("onrender.com") ? "" : "https://api.aadirishi.in";
}

/**
 * Wait for Firebase Auth to finish resolving its initial authentication state
 */
export function waitForAuthReady() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

/**
 * Obtain current authenticated Firebase ID token with coordinated refresh deduplication
 * @param {boolean} forceRefresh - whether to force-refresh the ID token
 * @returns {Promise<string>}
 */
export async function getAdminIdToken(forceRefresh = false) {
  const user = await waitForAuthReady();
  if (!user) {
    throw new Error("Admin authentication required. Please sign in.");
  }

  if (forceRefresh) {
    if (!inflightTokenRefreshPromise) {
      inflightTokenRefreshPromise = user.getIdToken(true).finally(() => {
        inflightTokenRefreshPromise = null;
      });
    }
    return inflightTokenRefreshPromise;
  }

  return user.getIdToken();
}

/**
 * Build standard headers with active Admin Authorization
 * @param {boolean} forceRefresh - whether to force token refresh
 * @param {Object} [customHeaders] - additional custom headers
 */
export async function getAdminAuthHeaders(forceRefresh = false, customHeaders = {}) {
  const token = await getAdminIdToken(forceRefresh);
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Authorization": `Bearer ${token}`,
    ...customHeaders
  };
}

/**
 * Centralized authenticated fetch for admin API endpoints.
 * Handles token acquisition, 401 refresh-and-single-retry, 403 abort, 429 rate limiting,
 * and concurrent GET deduplication.
 * 
 * @param {string} endpoint - API path (e.g. '/api/admin/models') or full URL
 * @param {RequestInit} [options] - fetch options
 * @param {boolean} [isRetry=false] - internal flag preventing infinite retry loops
 * @returns {Promise<Response>}
 */
export async function adminFetch(endpoint, options = {}, isRetry = false) {
  const baseUrl = getApiBaseUrl();
  const fullUrl = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;
  const method = (options.method || "GET").toUpperCase();

  // Deduplicate identical concurrent GET requests
  if (method === "GET" && !isRetry && inflightGetRequests.has(fullUrl)) {
    return inflightGetRequests.get(fullUrl);
  }

  const execute = async () => {
    let headers;
    try {
      headers = await getAdminAuthHeaders(isRetry, options.headers || {});
    } catch (authErr) {
      console.warn(`[AdminAuth] Authentication unavailable for ${endpoint}:`, authErr.message);
      // Return synthetic 401 response if user is unauthenticated
      return new Response(JSON.stringify({ 
        error: authErr.message, 
        code: "UNAUTHENTICATED" 
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    const response = await fetch(fullUrl, {
      ...options,
      headers
    });

    // 1. Handle 401 Unauthorized (Expired or Invalid token)
    if (response.status === 401) {
      if (!isRetry && auth.currentUser) {
        console.warn(`[AdminAuth] 401 from ${endpoint}. Refreshing token and retrying ONCE...`);
        try {
          // Force refresh token and retry at most once
          return await adminFetch(endpoint, options, true);
        } catch (refreshErr) {
          console.error("[AdminAuth] Token refresh failed:", refreshErr.message);
          dispatchSessionExpired("Your session could not be refreshed. Please sign in again.");
          return response;
        }
      } else {
        // Already retried or no active session — halt retries
        console.error(`[AdminAuth] Permanent 401 failure on ${endpoint}. Halting retries.`);
        dispatchSessionExpired("Your admin session has expired or is invalid. Please sign in again.");
        return response;
      }
    }

    // 2. Handle 403 Forbidden (Non-admin authorization failure)
    if (response.status === 403) {
      console.warn(`[AdminAuth] 403 Forbidden on ${endpoint}. User lacks admin claims.`);
      // Do not retry 403
      return response;
    }

    // 3. Handle 429 Too Many Requests
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitSec = retryAfter ? parseInt(retryAfter, 10) : 5;
      console.warn(`[AdminAuth] 429 Rate limited on ${endpoint}. Server requested wait of ${waitSec}s.`);
      return response;
    }

    return response;
  };

  const promise = execute().finally(() => {
    if (method === "GET") {
      inflightGetRequests.delete(fullUrl);
    }
  });

  if (method === "GET") {
    inflightGetRequests.set(fullUrl, promise);
  }

  return promise;
}

/**
 * Dispatch session expired event so UI components can display appropriate alerts
 */
function dispatchSessionExpired(message) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("admin-session-expired", {
      detail: { message }
    }));
  }
}

// Reset inflight state on auth changes
if (typeof window !== "undefined") {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      inflightGetRequests.clear();
      inflightTokenRefreshPromise = null;
    }
  });
}
