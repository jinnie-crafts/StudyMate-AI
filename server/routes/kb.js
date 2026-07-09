const express = require('express');
const fs = require('fs');
const path = require('path');
const knowledgeService = require('../services/knowledgeService');
const { loggers } = require('../services/logger');
const log = loggers.kb;

const router = express.Router();
const { kbDir } = require('../services/kbManager');

const ALLOWED_FILENAMES = new Set([
  'studymate-kb.json',
  'company.json',
  'features.json',
  'faq.json',
  'technology.json',
  'privacy.json',
  'support.json',
  'future-features.json'
]);

// Helper to save file
const saveFile = (filename, data) => {
  if (!ALLOWED_FILENAMES.has(filename)) {
    throw new Error('Invalid filename');
  }
  fs.writeFileSync(path.join(kbDir, filename), JSON.stringify(data, null, 2));
  knowledgeService.loadKB(); // Refresh in-memory service
};

// Get all KB categories
router.get('/', (req, res) => {
  try {
    const allData = knowledgeService.getAllKnowledge();
    res.json(allData);
  } catch (error) {
    log.error({ err: error }, 'Failed to load knowledge');
    res.status(500).json({ error: 'Failed to load knowledge' });
  }
});

// Update or Add Entry
router.post('/entry', async (req, res) => {
  const { filename, entry } = req.body;
  if (!filename || !entry || !entry.id) {
    return res.status(400).json({ error: 'Missing filename or entry data' });
  }

  // 1. Path Traversal & Whitelist Validation
  if (!ALLOWED_FILENAMES.has(filename)) {
    log.warn({ filename }, 'Blocked path traversal attempt in KB API');
    return res.status(400).json({ error: 'Invalid filename' });
  }

  // 2. Field-level Size Validation (Resource Exhaustion Prevention)
  if (entry.id.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(entry.id)) {
    return res.status(400).json({ error: 'Invalid or too long entry ID' });
  }
  if (entry.question && entry.question.length > 500) {
    return res.status(400).json({ error: 'Question field too long. Max 500 characters.' });
  }
  if (entry.answer && entry.answer.length > 5000) {
    return res.status(400).json({ error: 'Answer field too long. Max 5000 characters.' });
  }
  if (Array.isArray(entry.keywords)) {
    if (entry.keywords.length > 20) {
      return res.status(400).json({ error: 'Too many keywords. Max 20 allowed.' });
    }
    for (const kw of entry.keywords) {
      if (typeof kw !== 'string' || kw.length > 50) {
        return res.status(400).json({ error: 'Keyword must be string and max 50 characters.' });
      }
    }
  }

  try {
    await knowledgeService.addOrUpdateEntry(filename, entry);
    log.info({ filename, entryId: entry.id }, 'KB entry saved');
    res.json({ success: true, message: 'Entry saved' });
  } catch (e) {
    log.error({ err: e, filename, entryId: entry.id }, 'Failed to save KB entry');
    res.status(500).json({ error: 'Failed to save entry' });
  }
});

// Delete Entry
router.delete('/entry', async (req, res) => {
  const { filename, id } = req.body;
  if (!filename || !id) return res.status(400).json({ error: 'Missing parameters' });

  if (!ALLOWED_FILENAMES.has(filename)) {
    log.warn({ filename }, 'Blocked delete path traversal attempt in KB API');
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    await knowledgeService.deleteEntry(filename, id);
    log.info({ filename, entryId: id }, 'KB entry deleted');
    res.json({ success: true });
  } catch (e) {
    log.error({ err: e, filename, entryId: id }, 'Failed to delete KB entry');
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Sync to Firestore
router.post('/sync', async (req, res) => {
  try {
    const totalEntries = await knowledgeService.syncToFirestore();
    log.info({ totalEntries }, 'KB synced to Firestore');
    res.json({ success: true, count: totalEntries });
  } catch (err) {
    log.error({ err }, 'KB Firestore sync failed');
    res.status(500).json({ error: 'Firestore sync failed: ' + err.message });
  }
});

module.exports = router;
