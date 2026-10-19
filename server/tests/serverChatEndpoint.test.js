const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app } = require('../server');
const modelRegistry = require('../services/modelRegistry');
const aiService = require('../services/aiService');
const firebaseAdmin = require('../services/firebaseAdmin');

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

// Helper to make local HTTP requests to Express app
function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    if (body) {
      if (typeof body === 'object') {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

describe('Express Server Endpoints — Model Registry and Chat Pipeline', () => {
  let serverInstance = null;
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  let originalVerifyIdToken = null;

  beforeEach(async () => {
    process.env.OPENROUTER_API_KEY = 'test-server-openrouter-key-123';
    modelRegistry.invalidateCache();
    aiService.clearFailureTracker();

    // Mock Firebase auth token verification
    if (firebaseAdmin.auth) {
      originalVerifyIdToken = firebaseAdmin.auth.verifyIdToken;
      firebaseAdmin.auth.verifyIdToken = async (token) => {
        if (token === 'valid-student-token-12345') {
          return {
            uid: 'test-student-uid-456',
            email: 'student@studymate.ai',
            name: 'Alex Student',
            admin: false
          };
        }
        const err = new Error('Invalid token');
        err.code = 'auth/invalid-id-token';
        throw err;
      };
    }

    // Start ephemeral HTTP server on random port
    await new Promise((resolve) => {
      serverInstance = app.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    process.env.OPENROUTER_API_KEY = originalApiKey;
    if (firebaseAdmin.auth && originalVerifyIdToken) {
      firebaseAdmin.auth.verifyIdToken = originalVerifyIdToken;
    }
    if (serverInstance) {
      await new Promise(resolve => serverInstance.close(resolve));
    }
  });

  test('GET /api/models returns enabled models from authoritative registry', async () => {
    const res = await makeRequest(serverInstance, {
      path: '/api/models',
      method: 'GET'
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.models));
    assert.equal(data.models.length, 4);

    const keys = data.models.map(m => m.internal_key);
    assert.ok(keys.includes('general_chat'));
    assert.ok(keys.includes('coding_assistant'));
    assert.ok(keys.includes('fallback_model'));
    assert.ok(keys.includes('apodex_mini'));
  });

  test('GET /api/models?role=coding_assistant filters by role', async () => {
    const res = await makeRequest(serverInstance, {
      path: '/api/models?role=coding_assistant',
      method: 'GET'
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.models));
    for (const m of data.models) {
      assert.ok(m.roles.includes('coding_assistant'), `Model ${m.internal_key} must have coding_assistant role`);
    }
  });

  test('POST /api/chat rejects unauthenticated requests with 401', async () => {
    const res = await makeRequest(serverInstance, {
      path: '/api/chat',
      method: 'POST'
    }, {
      messages: [{ role: 'user', content: 'Hello' }]
    });

    assert.equal(res.statusCode, 401);
    const data = JSON.parse(res.body);
    assert.equal(data.code, 'MISSING_TOKEN');
  });

  test('POST /api/chat rejects message exceeding max length with 400', async () => {
    const longContent = 'A'.repeat(10001);
    const res = await makeRequest(serverInstance, {
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-student-token-12345'
      }
    }, {
      messages: [{ role: 'user', content: longContent }]
    });

    assert.equal(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error.includes('Maximum 10000 characters'));
  });

  test('POST /api/chat stream returns SSE events and dispatches exact provider ID', async () => {
    let chatRequestModel = null;

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);

      // Distinguish background memory extractor from chat stream
      if (body.stream) {
        chatRequestModel = body.model;
        const ssePayload = [
          'data: {"choices":[{"delta":{"content":"Photosynthesis is the process..."}}]}\n\n',
          'data: [DONE]\n\n'
        ];
        return {
          ok: true,
          status: 200,
          body: createSSEStream(ssePayload)
        };
      }

      // MemoryExtractor background call
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ facts: [] }) } }]
        })
      };
    };

    const res = await makeRequest(serverInstance, {
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-student-token-12345'
      }
    }, {
      messages: [{ role: 'user', content: 'What is photosynthesis?' }],
      stream: true,
      mode: 'general'
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/event-stream'));
    assert.ok(res.body.includes('Photosynthesis is the process...'));
    assert.ok(res.body.includes('[DONE]'));
    assert.equal(chatRequestModel, 'google/gemma-4-31b-it:free', 'General mode must resolve to authoritative general_chat model');
  });

  test('POST /api/chat JSON format returns structured reply with model_used', async () => {
    let chatRequestModel = null;

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);

      // First call is the main chat request
      if (!chatRequestModel) {
        chatRequestModel = body.model;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'def bubble_sort(arr):\n    pass'
                }
              }
            ]
          })
        };
      }

      // Background MemoryExtractor
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ facts: [] }) } }]
        })
      };
    };

    const res = await makeRequest(serverInstance, {
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-student-token-12345'
      }
    }, {
      messages: [{ role: 'user', content: 'Write a sorting algorithm in Python' }],
      stream: false,
      mode: 'coding'
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.reply.includes('bubble_sort'));
    assert.equal(data.model_used, 'cohere/north-mini-code:free');
    assert.equal(chatRequestModel, 'cohere/north-mini-code:free', 'Coding mode must resolve to cohere model');
  });

  test('POST /api/chat respects user model choice and dispatches provider ID', async () => {
    let chatRequestModel = null;

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);

      if (!chatRequestModel) {
        chatRequestModel = body.model;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Deep reasoning answer: Step 1...'
                }
              }
            ]
          })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ facts: [] }) } }]
        })
      };
    };

    const res = await makeRequest(serverInstance, {
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-student-token-12345'
      }
    }, {
      messages: [{ role: 'user', content: 'Prove sqrt(2) is irrational' }],
      stream: false,
      model_choice: 'deepseek_r1'
    });

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.model_used, 'google/gemma-4-31b-it:free');
    assert.equal(chatRequestModel, 'google/gemma-4-31b-it:free');
  });

  test('POST /api/chat returns clear 500 error when OPENROUTER_API_KEY is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    aiService.initialize({ apiKey: null });

    const res = await makeRequest(serverInstance, {
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer valid-student-token-12345'
      }
    }, {
      messages: [{ role: 'user', content: 'What is photosynthesis?' }],
      stream: false
    });

    assert.equal(res.statusCode, 500);
    const data = JSON.parse(res.body);
    assert.ok(data.error.includes('AI Service is not configured'));
    assert.ok(data.error.includes('OPENROUTER_API_KEY'));
    assert.equal(data.code, 'CONFIG_ERROR');
  });
});
