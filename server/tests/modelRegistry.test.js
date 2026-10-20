const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const modelRegistry = require('../services/modelRegistry');

describe('Model Registry — Dynamic AI Model Registry and Lifecycle', () => {

  beforeEach(() => {
    // Reset cache before each test
    modelRegistry.invalidateCache();
  });

  test('Loads authoritative model configuration with initial canonical models', async () => {
    const models = await modelRegistry.getAllModels({ enabledOnly: false });
    assert.ok(Array.isArray(models), 'Models must be an array');
    assert.ok(models.length >= 4, 'Must contain initial canonical models');

    const keys = models.map(m => m.internal_key);
    assert.ok(keys.includes('general_chat'), 'Must include general_chat');
    assert.ok(keys.includes('coding_assistant'), 'Must include coding_assistant');
    assert.ok(keys.includes('fallback_model'), 'Must include fallback_model');
    assert.ok(keys.includes('apodex_mini'), 'Must include apodex_mini');
  });

  test('Resolves all existing application roles to correct models and exact provider IDs', async () => {
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
    assert.ok(exam.roles.includes('exam_revision') || exam.roles.includes('general_chat'));

    const classifier = await modelRegistry.resolveModelForRole('fast_classifier');
    assert.ok(classifier, 'fast_classifier must resolve to an active model');
    assert.equal(classifier.provider_id, 'apodex/apodex-1.1-mini:free');

    const security = await modelRegistry.resolveModelForRole('security_guardrail');
    assert.ok(security, 'security_guardrail must resolve to an active model');
    assert.equal(security.provider_id, 'google/gemma-4-26b-a4b-it:free');

    const fallback = await modelRegistry.resolveModelForRole('fallback');
    assert.ok(fallback, 'fallback must resolve');
    assert.equal(fallback.provider_id, 'google/gemma-4-26b-a4b-it:free');
  });

  test('Builds candidate chain with defaults and fallback ordering', async () => {
    const chain = await modelRegistry.buildCandidateChain('general_chat');
    assert.ok(Array.isArray(chain), 'Chain must be an array');
    assert.ok(chain.length >= 2, 'Chain must have primary and fallbacks');

    // Primary should be first
    assert.equal(chain[0], 'google/gemma-4-31b-it:free');
    // Fallback model should be in chain
    assert.ok(chain.includes('google/gemma-4-26b-a4b-it:free'));
    // Apodex mini should be in chain
    assert.ok(chain.includes('apodex/apodex-1.1-mini:free'));
  });

  test('Normalizes legacy user preference aliases to registered models', async () => {
    // 'deepseek_r1' -> mapped to 'general_chat' -> 'google/gemma-4-31b-it:free'
    const chain = await modelRegistry.buildCandidateChain('general_chat', 'deepseek_r1');
    assert.equal(chain[0], 'google/gemma-4-31b-it:free', 'Legacy alias deepseek_r1 must map to general_chat provider');

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
    // Registered enabled models pass
    assert.equal(await modelRegistry.isAuthorizedModel('google/gemma-4-31b-it:free'), true);
    assert.equal(await modelRegistry.isAuthorizedModel('cohere/north-mini-code:free'), true);
    assert.equal(await modelRegistry.isAuthorizedModel('google/gemma-4-26b-a4b-it:free'), true);
    assert.equal(await modelRegistry.isAuthorizedModel('apodex/apodex-1.1-mini:free'), true);

    // Unregistered models fail
    assert.equal(await modelRegistry.isAuthorizedModel('nonexistent/model:free'), false);

    // Role-specific authorization
    assert.equal(await modelRegistry.isAuthorizedModel('cohere/north-mini-code:free', 'coding_assistant'), true);
    assert.equal(await modelRegistry.isAuthorizedModel('google/gemma-4-31b-it:free', 'coding_assistant'), false);
  });

  test('Allows administrators to dynamically add a new model with custom provider ID', async () => {
    const newModel = await modelRegistry.saveModel({
      internal_key: 'custom_study_pro',
      display_name: 'Custom Study Pro',
      provider_id: 'meta-llama/llama-3.3-70b-instruct:free',
      description: 'Dynamic newly added model',
      roles: ['general_chat'],
      capabilities: ['reasoning', 'study'],
      fallback_priority: 5,
      enabled: true,
      is_default: false
    }, { email: 'admin@studymate.ai' });

    assert.equal(newModel.internal_key, 'custom_study_pro');
    assert.equal(newModel.provider_id, 'meta-llama/llama-3.3-70b-instruct:free');
    assert.equal(newModel.display_name, 'Custom Study Pro');

    const fetched = await modelRegistry.getModelByKey('custom_study_pro');
    assert.ok(fetched, 'Must be retrievable by key');
    assert.equal(fetched.display_name, 'Custom Study Pro');

    // Verify it is authorized now
    assert.equal(await modelRegistry.isAuthorizedModel('meta-llama/llama-3.3-70b-instruct:free'), true);

    // Verify user can select it
    const chain = await modelRegistry.buildCandidateChain('general_chat', 'custom_study_pro');
    assert.equal(chain[0], 'meta-llama/llama-3.3-70b-instruct:free');

    // Clean up
    await modelRegistry.deleteModel('custom_study_pro', { email: 'admin@studymate.ai' });
  });

  test('Allows administrators to edit an existing model provider_id and display_name', async () => {
    const original = await modelRegistry.getModelByKey('apodex_mini');
    assert.ok(original);

    // Update display name and provider ID
    await modelRegistry.saveModel({
      internal_key: 'apodex_mini',
      display_name: 'Apodex Fast Custom',
      provider_id: 'apodex/apodex-updated-mini:free',
      description: 'Updated provider ID test',
      roles: ['fallback', 'fast_classifier'],
      capabilities: ['fast', 'fallback'],
      fallback_priority: 3,
      enabled: true,
      is_default: false,
      is_edit: true
    }, { email: 'admin@studymate.ai' });

    const updated = await modelRegistry.getModelByKey('apodex_mini');
    assert.equal(updated.display_name, 'Apodex Fast Custom');
    assert.equal(updated.provider_id, 'apodex/apodex-updated-mini:free');

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

  test('Protects active core defaults from accidental deletion without reassignment', async () => {
    // Attempting to delete general_chat when it is the sole active default model
    await assert.rejects(
      async () => {
        await modelRegistry.deleteModel('general_chat', { email: 'admin@studymate.ai' });
      },
      /Cannot delete/
    );
  });

  test('Validates model format: rejects malformed provider IDs and invalid keys', async () => {
    // Malformed provider ID
    await assert.rejects(
      async () => {
        await modelRegistry.saveModel({
          internal_key: 'invalid_format_test',
          display_name: 'Bad Model',
          provider_id: 'missing-slash-id',
          roles: ['general_chat'],
          enabled: true
        }, { email: 'admin@studymate.ai' });
      },
      /OpenRouter provider ID must follow/
    );

    // Malformed internal key
    await assert.rejects(
      async () => {
        await modelRegistry.saveModel({
          internal_key: 'INVALID KEY WITH SPACES',
          display_name: 'Bad Key Model',
          provider_id: 'valid/provider:id',
          roles: ['general_chat'],
          enabled: true
        }, { email: 'admin@studymate.ai' });
      },
      /Internal key must be/
    );
  });
});
