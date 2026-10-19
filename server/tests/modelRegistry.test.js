const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const modelRegistry = require('../services/modelRegistry');

describe('Model Registry — Authoritative Single Source of Truth (4-Model Whitelist)', () => {

  beforeEach(() => {
    // Reset cache before each test
    modelRegistry.invalidateCache();
  });

  test('Loads authoritative model configuration with exactly 4 approved models', async () => {
    const models = await modelRegistry.getAllModels({ enabledOnly: false });
    assert.ok(Array.isArray(models), 'Models must be an array');
    assert.equal(models.length, 4, 'Must contain exactly 4 approved whitelist models');

    const keys = models.map(m => m.internal_key);
    assert.ok(keys.includes('general_chat'), 'Must include general_chat');
    assert.ok(keys.includes('coding_assistant'), 'Must include coding_assistant');
    assert.ok(keys.includes('fallback_model'), 'Must include fallback_model');
    assert.ok(keys.includes('apodex_mini'), 'Must include apodex_mini');

    // Ensure obsolete models are not present
    assert.ok(!keys.includes('deepseek_r1'), 'Must not include deepseek_r1');
    assert.ok(!keys.includes('llama_3_3_70b'), 'Must not include llama_3_3_70b');
    assert.ok(!keys.includes('fast_classifier'), 'fast_classifier must not be a separate model');
    assert.ok(!keys.includes('security_classifier'), 'security_classifier must not be a separate model');
  });

  test('Resolves all existing application roles to correct approved models and exact provider IDs', async () => {
    const general = await modelRegistry.resolveModelForRole('general_chat');
    assert.ok(general, 'general_chat must resolve');
    assert.equal(general.provider_id, 'google/gemma-4-31b-it:free');
    assert.ok(general.roles.includes('general_chat'));

    const coding = await modelRegistry.resolveModelForRole('coding_assistant');
    assert.ok(coding, 'coding_assistant must resolve');
    assert.equal(coding.provider_id, 'cohere/north-mini-code:free');
    assert.ok(coding.roles.includes('coding_assistant'));

    const exam = await modelRegistry.resolveModelForRole('exam_revision');
    assert.ok(exam, 'exam_revision must resolve');
    assert.equal(exam.provider_id, 'google/gemma-4-31b-it:free');
    assert.ok(exam.roles.includes('exam_revision'));

    const classifier = await modelRegistry.resolveModelForRole('fast_classifier');
    assert.ok(classifier, 'fast_classifier must resolve to an approved model');
    assert.equal(classifier.provider_id, 'apodex/apodex-1.1-mini:free');

    const security = await modelRegistry.resolveModelForRole('security_guardrail');
    assert.ok(security, 'security_guardrail must resolve to an approved model');
    assert.equal(security.provider_id, 'google/gemma-4-26b-a4b-it:free');

    const fallback = await modelRegistry.resolveModelForRole('fallback');
    assert.ok(fallback, 'fallback must resolve');
    assert.equal(fallback.provider_id, 'google/gemma-4-26b-a4b-it:free');
  });

  test('Builds candidate chain with defaults and fallback ordering using only approved provider IDs', async () => {
    const chain = await modelRegistry.buildCandidateChain('general_chat');
    assert.ok(Array.isArray(chain), 'Chain must be an array');
    assert.ok(chain.length >= 2, 'Chain must have primary and fallbacks');

    // Primary should be first
    assert.equal(chain[0], 'google/gemma-4-31b-it:free');
    // Fallback model should be in chain
    assert.ok(chain.includes('google/gemma-4-26b-a4b-it:free'));
    // Apodex mini should be in chain
    assert.ok(chain.includes('apodex/apodex-1.1-mini:free'));

    // Verify all candidates are strictly in the approved provider ID set
    const approved = new Set([
      'google/gemma-4-31b-it:free',
      'cohere/north-mini-code:free',
      'google/gemma-4-26b-a4b-it:free',
      'apodex/apodex-1.1-mini:free'
    ]);
    for (const id of chain) {
      assert.ok(approved.has(id), `Candidate ${id} must be approved`);
    }
  });

  test('Normalizes legacy user preference aliases to approved models', async () => {
    // 'deepseek_r1' -> mapped to 'general_chat' -> 'google/gemma-4-31b-it:free'
    const chain = await modelRegistry.buildCandidateChain('general_chat', 'deepseek_r1');
    assert.equal(chain[0], 'google/gemma-4-31b-it:free', 'Legacy alias deepseek_r1 must map to general_chat approved provider');

    // 'coding' -> mapped to 'coding_assistant' -> 'cohere/north-mini-code:free'
    const codingChain = await modelRegistry.buildCandidateChain('coding_assistant', 'coding');
    assert.equal(codingChain[0], 'cohere/north-mini-code:free');
  });

  test('Rejects internal-only roles from user selection in chat', async () => {
    // fast_classifier is an internal role, cannot be selected directly by user for general chat
    const chain = await modelRegistry.buildCandidateChain('general_chat', 'fast_classifier');
    assert.equal(chain[0], 'google/gemma-4-31b-it:free', 'Must fall back to role default');
  });

  test('Rejects user model preferences not authorized for the requested role', async () => {
    // coding_assistant should not be used as primary for general_chat
    const chain = await modelRegistry.buildCandidateChain('general_chat', 'coding_assistant');
    assert.equal(chain[0], 'google/gemma-4-31b-it:free', 'Must use general_chat default');
  });

  test('Verifies isAuthorizedModel validation with role check', async () => {
    // Global authorization: approved models pass
    assert.equal(await modelRegistry.isAuthorizedModel('google/gemma-4-31b-it:free'), true);
    assert.equal(await modelRegistry.isAuthorizedModel('cohere/north-mini-code:free'), true);
    assert.equal(await modelRegistry.isAuthorizedModel('google/gemma-4-26b-a4b-it:free'), true);
    assert.equal(await modelRegistry.isAuthorizedModel('apodex/apodex-1.1-mini:free'), true);

    // Unapproved models fail
    assert.equal(await modelRegistry.isAuthorizedModel('deepseek/deepseek-r1:free'), false);
    assert.equal(await modelRegistry.isAuthorizedModel('meta-llama/llama-3.3-70b-instruct:free'), false);
    assert.equal(await modelRegistry.isAuthorizedModel('openrouter/free'), false);
    assert.equal(await modelRegistry.isAuthorizedModel('nonexistent/model:free'), false);

    // Role-specific authorization
    assert.equal(await modelRegistry.isAuthorizedModel('cohere/north-mini-code:free', 'coding_assistant'), true);
    assert.equal(await modelRegistry.isAuthorizedModel('google/gemma-4-31b-it:free', 'coding_assistant'), false);
  });

  test('Rejects adding a 5th model or unknown internal key', async () => {
    await assert.rejects(
      async () => {
        await modelRegistry.saveModel({
          internal_key: 'fifth_unapproved_model',
          display_name: 'Fifth Model',
          provider_id: 'some/model:free',
          roles: ['general_chat'],
          enabled: true
        }, { email: 'admin@studymate.ai' });
      },
      /Model creation is restricted/
    );
  });

  test('Rejects tampering with provider_id of approved models', async () => {
    await assert.rejects(
      async () => {
        await modelRegistry.saveModel({
          internal_key: 'general_chat',
          display_name: 'Gemma 4 31B (Free)',
          provider_id: 'malicious/tampered-model:free',
          roles: ['general_chat'],
          enabled: true,
          is_edit: true
        }, { email: 'admin@studymate.ai' });
      },
      /locked/
    );
  });

  test('Prevents deleting any of the 4 approved whitelist models', async () => {
    for (const key of ['general_chat', 'coding_assistant', 'fallback_model', 'apodex_mini']) {
      await assert.rejects(
        async () => {
          await modelRegistry.deleteModel(key, { email: 'admin@studymate.ai' });
        },
        /Cannot delete/
      );
    }
  });

  test('Preserves administrator display name and description edits', async () => {
    const original = await modelRegistry.getModelByKey('apodex_mini');
    assert.ok(original);

    // Modify description and display name as admin
    await modelRegistry.saveModel({
      internal_key: 'apodex_mini',
      display_name: 'Apodex 1.1 Mini (Custom Admin Name)',
      provider_id: 'apodex/apodex-1.1-mini:free',
      description: 'Modified by admin test',
      capabilities: ['fallback', 'fast'],
      roles: ['fallback', 'fast_classifier'],
      fallback_priority: 3,
      enabled: true,
      is_default: false,
      is_edit: true
    }, { email: 'admin@studymate.ai' });

    const updated = await modelRegistry.getModelByKey('apodex_mini');
    assert.equal(updated.display_name, 'Apodex 1.1 Mini (Custom Admin Name)');
    assert.equal(updated.description, 'Modified by admin test');
    assert.equal(updated.managed_by, 'admin');

    // Restore original
    await modelRegistry.saveModel({
      internal_key: 'apodex_mini',
      display_name: 'Apodex 1.1 Mini (Free)',
      provider_id: 'apodex/apodex-1.1-mini:free',
      description: 'Ultra-fast lightweight fallback engine for rapid response, intent detection, and failover continuity.',
      capabilities: ['fallback', 'fast', 'general'],
      roles: ['fallback', 'fast_classifier'],
      fallback_priority: 3,
      enabled: true,
      is_default: false,
      is_edit: true
    }, { email: 'system' });
  });
});
