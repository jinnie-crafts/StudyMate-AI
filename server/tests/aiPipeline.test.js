const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const aiService = require('../services/aiService');
const modelRegistry = require('../services/modelRegistry');

// Helper to create SSE stream readable stream
function createSSEStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

describe('AI Request Pipeline — Authoritative Integration with OpenRouter Transport', () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key-sk-or-v1-abc123';
    modelRegistry.invalidateCache();
    aiService.clearFailureTracker();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.OPENROUTER_API_KEY = originalApiKey;
    aiService.clearFailureTracker();
  });

  test('General chat resolves and sends exact provider_id to OpenRouter', async () => {
    let capturedRequest = null;

    global.fetch = async (url, options) => {
      capturedRequest = {
        url,
        method: options.method,
        headers: options.headers,
        body: JSON.parse(options.body)
      };

      const ssePayload = [
        'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world!"}}]}\n\n',
        'data: [DONE]\n\n'
      ];

      return {
        ok: true,
        status: 200,
        body: createSSEStream(ssePayload)
      };
    };

    const chunks = [];
    const result = await aiService.executeChatStream({
      role: 'general_chat',
      messages: [{ role: 'user', content: 'What is photosynthesis?' }],
      onChunk: (chunk) => chunks.push(chunk)
    });

    assert.ok(result.success, 'Stream request should succeed');
    assert.equal(result.usedModel, 'google/gemma-4-31b-it:free', 'Must use authoritative provider_id');
    assert.equal(result.fullText, 'Hello world!');
    assert.deepEqual(chunks, ['Hello ', 'world!']);

    // Verify OpenRouter request payload
    assert.ok(capturedRequest, 'Fetch must have been called');
    assert.equal(capturedRequest.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(capturedRequest.body.model, 'google/gemma-4-31b-it:free', 'Model sent to OpenRouter must strictly match provider_id');
    assert.equal(capturedRequest.headers['Authorization'], 'Bearer test-openrouter-key-sk-or-v1-abc123');
    assert.equal(capturedRequest.body.stream, true);
    assert.deepEqual(capturedRequest.body.messages, [{ role: 'user', content: 'What is photosynthesis?' }]);
  });

  test('Coding assistant resolves and sends exact provider_id to OpenRouter', async () => {
    let capturedRequest = null;

    global.fetch = async (url, options) => {
      capturedRequest = {
        url,
        body: JSON.parse(options.body)
      };

      const ssePayload = [
        'data: {"choices":[{"delta":{"content":"```python\\nprint(1)\\n```"}}]}\n\n',
        'data: [DONE]\n\n'
      ];

      return {
        ok: true,
        status: 200,
        body: createSSEStream(ssePayload)
      };
    };

    const result = await aiService.executeChatStream({
      role: 'coding_assistant',
      messages: [{ role: 'user', content: 'Write a python script' }],
      onChunk: () => {}
    });

    assert.ok(result.success);
    assert.equal(result.usedModel, 'cohere/north-mini-code:free');
    assert.equal(capturedRequest.body.model, 'cohere/north-mini-code:free', 'Coding role must send cohere provider_id');
  });

  test('Exam revision resolves and sends exact provider_id to OpenRouter', async () => {
    let capturedRequest = null;

    global.fetch = async (url, options) => {
      capturedRequest = {
        url,
        body: JSON.parse(options.body)
      };

      const ssePayload = [
        'data: {"choices":[{"delta":{"content":"Revision note: Newtons laws..."}}]}\n\n',
        'data: [DONE]\n\n'
      ];

      return {
        ok: true,
        status: 200,
        body: createSSEStream(ssePayload)
      };
    };

    const result = await aiService.executeChatStream({
      role: 'exam_revision',
      messages: [{ role: 'user', content: 'Explain Newtons second law' }],
      onChunk: () => {}
    });

    assert.ok(result.success);
    assert.equal(result.usedModel, 'google/gemma-4-31b-it:free');
    assert.equal(capturedRequest.body.model, 'google/gemma-4-31b-it:free');
  });

  test('Prioritizes authorized user model choice in OpenRouter request or normalizes legacy choice', async () => {
    let capturedModel = null;

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      capturedModel = body.model;

      const ssePayload = [
        'data: {"choices":[{"delta":{"content":"Gemma response"}}]}\n\n',
        'data: [DONE]\n\n'
      ];

      return {
        ok: true,
        status: 200,
        body: createSSEStream(ssePayload)
      };
    };

    const result = await aiService.executeChatStream({
      role: 'general_chat',
      userChoice: 'deepseek_r1', // user had legacy DeepSeek R1 preference
      messages: [{ role: 'user', content: 'Hello' }],
      onChunk: () => {}
    });

    assert.ok(result.success);
    assert.equal(result.usedModel, 'google/gemma-4-31b-it:free');
    assert.equal(capturedModel, 'google/gemma-4-31b-it:free', 'Must dispatch approved Gemma 4 31B provider_id');
  });

  test('Falls back seamlessly to secondary model on 429 rate limit error', async () => {
    const attemptedModels = [];

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      attemptedModels.push(body.model);

      if (body.model === 'google/gemma-4-31b-it:free') {
        // Simulate rate-limiting on primary
        return {
          ok: false,
          status: 429,
          text: async () => 'Rate limit exceeded: please slow down'
        };
      }

      // Secondary candidate succeeds
      const ssePayload = [
        'data: {"choices":[{"delta":{"content":"Fallback model response"}}]}\n\n',
        'data: [DONE]\n\n'
      ];

      return {
        ok: true,
        status: 200,
        body: createSSEStream(ssePayload)
      };
    };

    const result = await aiService.executeChatStream({
      role: 'general_chat',
      messages: [{ role: 'user', content: 'Hello' }],
      onChunk: () => {}
    });

    assert.ok(result.success);
    assert.equal(attemptedModels.length, 2, 'Should have tried primary then fallback');
    assert.equal(attemptedModels[0], 'google/gemma-4-31b-it:free', 'First attempt was primary');
    assert.equal(attemptedModels[1], 'google/gemma-4-26b-a4b-it:free', 'Second attempt was fallback');
    assert.equal(result.usedModel, 'google/gemma-4-26b-a4b-it:free');
    assert.equal(result.fullText, 'Fallback model response');

    // Verify primary is now in failure cooldown tracker
    const status = aiService.getFailureTrackerStatus();
    assert.ok(status['google/gemma-4-31b-it:free'], 'Failed model must be recorded in cooldown tracker');
    assert.equal(status['google/gemma-4-31b-it:free'].reason, 'RATE_LIMITED');
  });

  test('Aborts immediately without retrying candidates on 401 provider auth failure', async () => {
    const attemptedModels = [];

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      attemptedModels.push(body.model);

      return {
        ok: false,
        status: 401,
        text: async () => 'Invalid API key or unauthorized'
      };
    };

    await assert.rejects(
      async () => {
        await aiService.executeChatStream({
          role: 'general_chat',
          messages: [{ role: 'user', content: 'Hello' }],
          onChunk: () => {}
        });
      },
      (err) => {
        assert.ok(err.message.includes('PROVIDER_AUTH_ERROR') || err.message.includes('401'));
        return true;
      }
    );

    // Assert that we did NOT attempt fallback candidates on hard auth error
    assert.equal(attemptedModels.length, 1, 'Must not retry other models on auth failure');
  });

  test('JSON completion (executeChatCompletion) resolves role and returns content', async () => {
    let capturedBody = null;

    global.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Structured JSON answer from Gemma'
              }
            }
          ]
        })
      };
    };

    const result = await aiService.executeChatCompletion({
      role: 'general_chat',
      messages: [{ role: 'user', content: 'Summarize briefly' }]
    });

    assert.ok(result.success);
    assert.equal(result.modelUsed, 'google/gemma-4-31b-it:free');
    assert.equal(result.content, 'Structured JSON answer from Gemma');
    assert.equal(capturedBody.model, 'google/gemma-4-31b-it:free');
  });

  test('Direct completion for internal security_guardrail uses exact provider ID', async () => {
    let capturedBody = null;

    global.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'SAFE: 0.05'
              }
            }
          ]
        })
      };
    };

    const result = await aiService.executeDirectCompletion({
      role: 'security_guardrail',
      messages: [{ role: 'user', content: 'Check this text' }]
    });

    assert.ok(result.success);
    assert.equal(result.modelUsed, 'google/gemma-4-26b-a4b-it:free');
    assert.equal(capturedBody.model, 'google/gemma-4-26b-a4b-it:free');
  });

  test('Direct completion for fast_classifier uses exact provider ID', async () => {
    let capturedBody = null;

    global.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'FACT: user likes science'
              }
            }
          ]
        })
      };
    };

    const result = await aiService.executeDirectCompletion({
      role: 'fast_classifier',
      messages: [{ role: 'user', content: 'Extract facts' }]
    });

    assert.ok(result.success);
    assert.equal(result.modelUsed, 'apodex/apodex-1.1-mini:free');
    assert.equal(capturedBody.model, 'apodex/apodex-1.1-mini:free');
  });

  test('Throws clean error when OPENROUTER_API_KEY is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;

    await assert.rejects(
      async () => {
        await aiService.executeChatStream({
          role: 'general_chat',
          messages: [{ role: 'user', content: 'Test without key' }],
          onChunk: () => {}
        });
      },
      /CONFIG_ERROR/
    );
  });
});
