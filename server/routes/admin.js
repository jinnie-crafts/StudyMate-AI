const express = require('express');
const router = express.Router();
const { db, FieldValue } = require('../services/firebaseAdmin');
const crypto = require('crypto');
const { verifyAdmin } = require('../services/authMiddleware');
const { loggers } = require('../services/logger');
const log = loggers.admin;

// POST /api/admin/security/reset
router.post('/security/reset', verifyAdmin, async (req, res) => {
  const { targetUserId, targetEmail, previousScore, previousLevel, reason } = req.body;
  
  if (!targetUserId || !reason) {
    return res.status(400).json({ error: 'Missing targetUserId or reason' });
  }

  const adminUid = req.adminUser.uid;
  const adminEmail = req.adminUser.email || 'Admin';

  const logEntry = {
    eventId: crypto.randomUUID(),
    eventType: "admin_reset",
    targetUserId: targetUserId,
    targetEmail: targetEmail || '',
    adminUid: adminUid,
    adminEmail: adminEmail,
    actionPerformed: "reset_threat_score",
    reason: reason,
    previousScore: previousScore || 0,
    previousLevel: previousLevel || 'low',
    threatScore: 0,
    timestamp: FieldValue.serverTimestamp()
  };

  try {
    if (db && typeof db.collection === 'function') {
      await db.collection('security_logs').add(logEntry);
    }
    log.info({ adminUid, targetUserId }, 'Threat score reset successfully');
    res.json({ success: true, message: 'Threat score and enforcement cleared successfully.' });
  } catch (err) {
    log.error({ err, adminUid, targetUserId }, 'Failed to record admin reset action');
    res.status(500).json({ error: 'Failed to record reset action.' });
  }
});

// --- AI Model Registry Admin Endpoints ---
const modelRegistry = require('../services/modelRegistry');

// GET /api/admin/models — list all models
router.get('/models', verifyAdmin, async (_req, res) => {
  try {
    const models = await modelRegistry.getAllModels({ enabledOnly: false });
    res.json({ success: true, models });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to list models for admin');
    res.status(500).json({ error: 'Failed to load model registry.' });
  }
});

// POST /api/admin/models — create a new model
router.post('/models', verifyAdmin, async (req, res) => {
  try {
    const model = await modelRegistry.saveModel({ ...req.body, is_edit: false }, req.adminUser);
    res.status(201).json({ success: true, model });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to create model.' });
  }
});

// PUT /api/admin/models/:key — update an existing model
router.put('/models/:key', verifyAdmin, async (req, res) => {
  try {
    const model = await modelRegistry.saveModel({
      ...req.body,
      internal_key: req.params.key,
      is_edit: true
    }, req.adminUser);
    res.json({ success: true, model });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to update model.' });
  }
});

// DELETE /api/admin/models/:key — safely remove a model
router.delete('/models/:key', verifyAdmin, async (req, res) => {
  try {
    const result = await modelRegistry.deleteModel(req.params.key, req.adminUser);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to delete model.' });
  }
});

// POST /api/admin/models/test — test OpenRouter model connectivity
router.post('/models/test', verifyAdmin, async (req, res) => {
  const { provider_id } = req.body;
  if (!provider_id) {
    return res.status(400).json({ error: 'Missing provider_id.' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured on server.' });
  }

  try {
    const testResult = await modelRegistry.testModelConnection(provider_id, apiKey);
    res.json(testResult);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
