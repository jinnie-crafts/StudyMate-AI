import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import modelRegistry from "../services/modelRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

describe("Priority 1: SPA View Mounting & Layering Isolation", () => {
  it("style.css enforces strict hiding of dashboard container when on settings or legal", () => {
    const cssPath = path.join(rootDir, "style.css");
    const css = fs.readFileSync(cssPath, "utf-8");

    // Verify .app-container does NOT have display: flex !important
    assert.doesNotMatch(
      css,
      /\.app-container\s*\{[^}]*display:\s*flex\s*!important/i,
      ".app-container must not use display: flex !important so view hiding can take effect"
    );

    // Verify body[data-page='settings'] and body[data-page='legal'] hide the dashboard container
    assert.match(
      css,
      /body\[data-page="settings"\]\s*#app,\s*body\[data-page="settings"\]\s*\.app-container[\s\S]*display:\s*none\s*!important/i,
      "style.css must hide #app and .app-container on settings page with !important"
    );

    assert.match(
      css,
      /body\[data-page="dashboard"\]\s*#spaSettingsMount[\s\S]*display:\s*none\s*!important/i,
      "style.css must hide #spaSettingsMount on dashboard page with !important"
    );
  });

  it("spaNavigation.js toggles spa-hidden class and uses important inline display", () => {
    const jsPath = path.join(rootDir, "spaNavigation.js");
    const js = fs.readFileSync(jsPath, "utf-8");

    assert.ok(
      js.includes("classList.add(\"spa-hidden\")"),
      "spaNavigation.js must add spa-hidden class when hiding views"
    );
    assert.ok(
      js.includes("style.setProperty(\"display\", \"none\", \"important\")"),
      "spaNavigation.js must set display: none !important on hidden views"
    );
    assert.ok(
      js.includes("classList.remove(\"spa-hidden\")"),
      "spaNavigation.js must remove spa-hidden class when unhiding active view"
    );
  });
});

describe("Priority 2: Admin Model Registry Container & CSP Compliance", () => {
  it("admin.html contains tab-models and tab-securitylogs inside main#adminContent", () => {
    const htmlPath = path.join(rootDir, "admin.html");
    const html = fs.readFileSync(htmlPath, "utf-8");

    const mainStart = html.indexOf('<main id="adminContent"');
    const mainEnd = html.indexOf('</main>');
    const tabModels = html.indexOf('id="tab-models"');
    const tabSecurity = html.indexOf('id="tab-securitylogs"');

    assert.ok(mainStart !== -1, "main#adminContent must exist");
    assert.ok(mainEnd !== -1, "</main> must exist");
    assert.ok(
      tabModels > mainStart && tabModels < mainEnd,
      "#tab-models must be located inside <main id=\"adminContent\">"
    );
    assert.ok(
      tabSecurity > mainStart && tabSecurity < mainEnd,
      "#tab-securitylogs must be located inside <main id=\"adminContent\">"
    );
  });

  it("adminModelRegistry.js contains zero inline onclick/onmouseover handlers", () => {
    const jsPath = path.join(rootDir, "adminModelRegistry.js");
    const js = fs.readFileSync(jsPath, "utf-8");

    const inlineHandlers = js.match(/\bon[a-z]+\s*=\s*["'][^"']*["']/gi) || [];
    assert.deepStrictEqual(
      inlineHandlers,
      [],
      `adminModelRegistry.js must not generate inline event handlers, found: ${inlineHandlers.join(", ")}`
    );

    assert.ok(
      js.includes("data-action="),
      "adminModelRegistry.js must use data-action attributes for button event delegation"
    );
  });

  it("admin.js initializes model registry when tab-models is clicked", () => {
    const jsPath = path.join(rootDir, "admin.js");
    const js = fs.readFileSync(jsPath, "utf-8");

    assert.ok(
      js.includes('btn.dataset.tab === "tab-models"'),
      "admin.js must detect tab-models selection in click handler"
    );
    assert.ok(
      js.includes("initModelRegistry()"),
      "admin.js must call initModelRegistry() on tab switch"
    );
  });
});

describe("Priority 3: AI Chat Error Handling & Draft Preservation", () => {
  it("app.js preserves user draft and renders error bubble when AI request fails", () => {
    const appPath = path.join(rootDir, "app.js");
    const code = fs.readFileSync(appPath, "utf-8");

    assert.ok(
      code.includes("ui.userInput.value = userContent"),
      "app.js must restore userContent into userInput draft upon error"
    );
    assert.ok(
      code.includes("Unable to complete response"),
      "app.js must render a clear error message bubble in chat upon failure"
    );
    assert.ok(
      code.includes("state.isSending = false"),
      "app.js must reset isSending in finally block"
    );
    assert.ok(
      code.includes("setComposerLoading(false)"),
      "app.js must reset composer loading in finally block"
    );
  });

  it("app.js stream parser detects and formats data.error payload", () => {
    const appPath = path.join(rootDir, "app.js");
    const code = fs.readFileSync(appPath, "utf-8");

    assert.ok(
      code.includes("data.error"),
      "streamAssistantMessage must check for data.error in stream events"
    );
    assert.ok(
      code.includes("Error receiving response"),
      "streamAssistantMessage must format stream error message"
    );
  });
});

describe("Priority 4: Send Button Vector Icon & Styling", () => {
  it("index.html contains inline SVG paper-plane icon in sendBtn", () => {
    const htmlPath = path.join(rootDir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf-8");

    const sendBtnMatch = html.match(/<button id="sendBtn"[^>]*>([\s\S]*?)<\/button>/i);
    assert.ok(sendBtnMatch, "button#sendBtn must exist in index.html");

    const inner = sendBtnMatch[1];
    assert.ok(!inner.includes("img/send.png"), "sendBtn must not use img/send.png");
    assert.ok(inner.includes("<svg"), "sendBtn must contain inline SVG");
    assert.ok(inner.includes("polygon"), "sendBtn SVG must contain paper plane polygon");
    assert.ok(inner.includes("send-icon"), "SVG must have send-icon class");
  });

  it("style.css styles send-icon with white stroke and without filter invert", () => {
    const cssPath = path.join(rootDir, "style.css");
    const css = fs.readFileSync(cssPath, "utf-8");

    assert.doesNotMatch(
      css,
      /\.send-icon\s*\{[^}]*filter:\s*brightness\(0\)\s*invert\(1\)/i,
      "style.css must not invert send-icon filter"
    );
    assert.match(
      css,
      /\.send-icon\s*\{[^}]*stroke:\s*#ffffff/i,
      "style.css must stroke send-icon with white #ffffff"
    );
  });
});
