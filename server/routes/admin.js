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
    await db.collection('security_logs').add(logEntry);
    log.info({ adminUid, targetUserId }, 'Threat score reset successfully');
    res.json({ success: true, message: 'Threat score and enforcement cleared successfully.' });
  } catch (err) {
    log.error({ err, adminUid, targetUserId }, 'Failed to record admin reset action');
    res.status(500).json({ error: 'Failed to record reset action.' });
  }
});

module.exports = router;
