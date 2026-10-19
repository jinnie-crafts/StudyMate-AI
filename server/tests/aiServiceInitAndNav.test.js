import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import aiService from "../services/aiService.js";
import modelRegistry from "../services/modelRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

describe("AI Service Initialization & Configuration Validation", () => {
  it("validateConfig detects missing API key and returns actionable error", () => {
    const originalKey = process.env.OPENROUTER_API_KEY;
    try {
      delete process.env.OPENROUTER_API_KEY;
      aiService.initialize({ apiKey: null });
      const status = aiService.validateConfig();
      assert.strictEqual(status.valid, false);
      assert.ok(status.error.includes("OPENROUTER_API_KEY"));
      assert.ok(status.error.includes("server/.env") || status.error.includes("Render"));
    } finally {
      process.env.OPENROUTER_API_KEY = originalKey;
      aiService.initialize({ apiKey: originalKey });
    }
  });

  it("validateConfig recognizes valid API key", () => {
    aiService.initialize({ apiKey: "sk-or-v1-mock-test-key-for-validation" });
    const status = aiService.validateConfig();
    assert.strictEqual(status.valid, true);
    assert.strictEqual(status.error, undefined);
  });

  it("Model Registry preserves all four approved provider IDs strictly", async () => {
    const models = await modelRegistry.getAllModels();
    const approvedProviderIds = new Set([
      "google/gemma-4-31b-it:free",
      "cohere/north-mini-code:free",
      "google/gemma-4-26b-a4b-it:free",
      "apodex/apodex-1.1-mini:free"
    ]);

    assert.strictEqual(models.length, 4, "Must have exactly 4 models registered");
    for (const model of models) {
      assert.ok(
        approvedProviderIds.has(model.provider_id),
        `Provider ID ${model.provider_id} must be in approved whitelist`
      );
    }
  });
});

describe("CSP Violations & Inline Handler Auditing", () => {
  const htmlFiles = [
    "index.html",
    "login.html",
    "signup.html",
    "terms.html",
    "privacy.html",
    "settings.html",
    "recover.html",
    "reset.html",
    "verify.html"
  ];

  for (const file of htmlFiles) {
    it(`${file} has zero inline event handlers (onclick, onload) and zero inline scripts`, () => {
      const filePath = path.join(rootDir, file);
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, "utf-8");

      // Check for inline event handlers like onclick="...", onload="..."
      const onclickMatches = content.match(/\bon[a-z]+\s*=\s*["'][^"']*["']/gi) || [];
      assert.deepStrictEqual(
        onclickMatches,
        [],
        `File ${file} should have 0 inline event handlers, found: ${onclickMatches.join(", ")}`
      );

      // Check for inline non-JSON script tags
      // We allow <script type="application/ld+json">, but no executable inline JS
      const scriptRegex = /<script(?![^>]*type\s*=\s*["']application\/(ld\+json|json)["'])[^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      const inlineScripts = [];
      while ((match = scriptRegex.exec(content)) !== null) {
        const fullTag = match[0];
        const innerText = match[2].trim();
        // If it doesn't have src="..." and has innerText, it's an inline script
        if (!fullTag.includes("src=") && innerText.length > 0) {
          inlineScripts.push(innerText.slice(0, 50));
        }
      }

      assert.deepStrictEqual(
        inlineScripts,
        [],
        `File ${file} should have 0 inline scripts, found: ${inlineScripts.length}`
      );
    });
  }

  it("terms.html and privacy.html contain data-page='legal' and backBtn button", () => {
    for (const legalFile of ["terms.html", "privacy.html"]) {
      const content = fs.readFileSync(path.join(rootDir, legalFile), "utf-8");
      assert.ok(content.includes('data-page="legal"'), `${legalFile} must specify data-page="legal"`);
      assert.ok(content.includes('id="backBtn"'), `${legalFile} must include id="backBtn"`);
      assert.ok(content.includes('src="legal.js"'), `${legalFile} must load external legal.js module`);
    }
  });

  it("index.html contains id='app' on app-container", () => {
    const content = fs.readFileSync(path.join(rootDir, "index.html"), "utf-8");
    assert.ok(
      content.includes('id="app"') && content.includes('class="app-container"'),
      "index.html must have id='app' on app-container"
    );
  });
});
