const fs = require('fs');
const path = require('path');
const { db, FieldValue } = require('./firebaseAdmin');
const { kbDir, initKnowledgeBase } = require('./kbManager');

class KnowledgeService {
  constructor() {
    initKnowledgeBase();
    this.kbPath = kbDir;
    this.entries = [];
    this.categories = []; // cache grouped by sourceFile for API
    this.synonyms = {
      "built": ["created", "made", "developed", "programmed", "coded"],
      "cost": ["price", "free", "premium", "pay", "subscription", "money", "tier"],
      "secure": ["safe", "privacy", "protect", "encryption", "encrypted"],
      "help": ["support", "contact", "email", "ticket", "issue", "problem", "bug"],
      "future": ["roadmap", "upcoming", "next", "soon", "planning"],
      "notes": ["notebook", "save", "download", "document"],
      "chat": ["assistant", "bot", "talk", "speak"]
    };
    // Load once on startup
    this.loadKB().catch(err => {
      console.warn("[KnowledgeService] Error loading knowledge base:", err.message);
    });
  }

  async loadKB() {
    console.log("Loading Knowledge...");
    this.entries = [];
    this.categories = [];

    try {
      // 1. Try Firestore First (if Firestore is initialized with GCP credentials)
      if (db && typeof db.collection === 'function') {
        const snapshot = await db.collection("knowledge").get();
      
      if (!snapshot.empty) {
        console.log("Firestore Read Success");
        const grouped = {};
        
        snapshot.forEach(doc => {
          const data = doc.data();
          const entry = {
            id: doc.id,
            category: data.category || 'Uncategorized',
            question: data.question || data.title || "",
            answer: data.answer || "",
            keywords: Array.isArray(data.keywords) ? data.keywords : [],
            sourceFile: data.sourceFile || 'uncategorized.json',
            version: data.version || "1.0",
            lastUpdated: data.lastUpdated || new Date().toISOString().split('T')[0],
            verified: data.verified !== undefined ? data.verified : true,
            source: data.source || "Official StudyMate AI Documentation"
          };

          this.entries.push(entry);

          // Group for API
          if (!grouped[entry.sourceFile]) {
            grouped[entry.sourceFile] = {
              filename: entry.sourceFile,
              category: entry.category,
              entries: []
            };
          }
          grouped[entry.sourceFile].entries.push(entry);
        });

        this.categories = Object.values(grouped);
        
        console.log("Loaded From Firestore");
        console.log(`Entries Loaded: ${this.entries.length}`);
        console.log(`Categories Loaded: ${this.categories.length}`);
        console.log("Knowledge Cache Loaded");
        
        // Export snapshot to local JSON
        this.exportToLocalJson(grouped);
        } else {
          console.log("Firestore Read Success but empty.");
        }
      }
    } catch (e) {
      console.log("Firestore Read Failed", e.message);
    }

    // 2. Fallback to Local JSON
    if (fs.existsSync(this.kbPath)) {
      const files = fs.readdirSync(this.kbPath).filter(f => f.endsWith('.json'));
      const grouped = {};

      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.kbPath, file), 'utf8');
          const data = JSON.parse(raw);
          if (data && Array.isArray(data.entries)) {
            grouped[file] = {
              filename: file,
              category: data.category || 'Uncategorized',
              entries: data.entries
            };

            data.entries.forEach(e => {
              this.entries.push({
                id: e.id,
                category: data.category,
                question: e.question || e.title || "",
                answer: e.answer || "",
                keywords: Array.isArray(e.keywords) ? e.keywords : [],
                version: data.version,
                lastUpdated: e.lastUpdated || data.lastUpdated || new Date().toISOString().split('T')[0],
                sourceFile: file,
                verified: e.verified !== undefined ? e.verified : true,
                source: e.source || "Official StudyMate AI Documentation"
              });
            });
          }
        } catch (e) {
          console.error(`[KnowledgeService] Failed to load ${file}:`, e.message);
        }
      }
      this.categories = Object.values(grouped);
      console.log("Loaded From Local Backup");
      console.log(`Entries Loaded: ${this.entries.length}`);
      console.log("Knowledge Cache Loaded");
    }
  }

  exportToLocalJson(grouped) {
    if (!fs.existsSync(this.kbPath)) {
      fs.mkdirSync(this.kbPath, { recursive: true });
    }
    for (const [filename, data] of Object.entries(grouped)) {
      const exportData = {
        category: data.category,
        version: "1.0",
        lastUpdated: new Date().toISOString().split('T')[0],
        entries: data.entries
      };
      fs.writeFileSync(path.join(this.kbPath, filename), JSON.stringify(exportData, null, 2));
    }
  }

  getAllKnowledge() {
    return this.categories;
  }

  async addOrUpdateEntry(filename, entry) {
    if (!entry || !entry.id) throw new Error("Entry missing ID");
    
    // Attempt to figure out category from existing cache
    const existingCat = this.categories.find(c => c.filename === filename);
    const categoryName = existingCat ? existingCat.category : filename.replace('.json', '');

    const payload = {
      ...entry,
      category: categoryName,
      sourceFile: filename,
      verified: entry.verified !== undefined ? entry.verified : false,
      updatedAt: FieldValue.serverTimestamp()
    };

    // 1. Save to Firestore
    await db.collection("knowledge").doc(entry.id).set(payload, { merge: true });

    // 2. Refresh Cache
    await this.loadKB();
    console.log("Cache Refreshed");
  }

  async deleteEntry(filename, id) {
    if (!id) throw new Error("Missing ID");
    
    // 1. Delete from Firestore
    await db.collection("knowledge").doc(id).delete();

    // 2. Refresh Cache
    await this.loadKB();
    console.log("Cache Refreshed");
  }

  async syncToFirestore() {
    console.log("Knowledge sync started");
    if (!fs.existsSync(this.kbPath)) {
      throw new Error("Knowledge directory not found");
    }

    const files = fs.readdirSync(this.kbPath).filter(f => f.endsWith('.json'));
    let totalEntries = 0;
    let allCategories = [];

    for (const file of files) {
      const raw = fs.readFileSync(path.join(this.kbPath, file), 'utf8');
      const data = JSON.parse(raw);
      const category = data.category;
      allCategories.push(category);

      if (!data.entries || !Array.isArray(data.entries)) continue;

      const batch = db.batch();
      for (const entry of data.entries) {
        const docRef = db.collection("knowledge").doc(entry.id);
        batch.set(docRef, {
          ...entry,
          category,
          sourceFile: file,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        totalEntries++;
      }
      await batch.commit();
    }
    
    console.log("Knowledge sync completed");
    // Reload cache after sync
    await this.loadKB();
    console.log("Cache Refreshed");
    return totalEntries;
  }

  tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w && w.length > 2); // Ignore very short stop words
  }

  expandSynonyms(tokens) {
    const expanded = new Set(tokens);
    for (const token of tokens) {
      for (const [key, syns] of Object.entries(this.synonyms)) {
        if (token === key || syns.includes(token)) {
          expanded.add(key);
          syns.forEach(s => expanded.add(s));
        }
      }
    }
    return Array.from(expanded);
  }

  search(query) {
    if (!query || this.entries.length === 0) return { bestMatch: null, confidence: 0 };

    const rawQuery = query.toLowerCase().trim();
    const queryTokens = this.tokenize(query);
    const expandedTokens = this.expandSynonyms(queryTokens);

    let bestMatch = null;
    let highestScore = 0;

    for (const entry of this.entries) {
      // RULE 6: Only verified entries may be used
      if (entry.verified !== true) continue;

      let score = 0;

      if (entry.question.toLowerCase() === rawQuery) {
        return { bestMatch: entry, confidence: 1.0 };
      }

      const safeKeywords = Array.isArray(entry.keywords) ? entry.keywords : [];
      const entryKeywords = this.expandSynonyms(safeKeywords.map(k => String(k).toLowerCase()));
      let keywordHits = 0;
      for (const token of expandedTokens) {
        if (entryKeywords.includes(token)) keywordHits++;
      }
      
      const keywordScore = (keywordHits / Math.max(expandedTokens.length, 1)) * 0.5;
      score += keywordScore;

      const qTokens = this.tokenize(entry.question);
      let qHits = 0;
      for (const token of expandedTokens) {
        if (qTokens.includes(token)) qHits++;
      }
      const qScore = (qHits / Math.max(qTokens.length, 1)) * 0.4;
      score += qScore;

      if (entryKeywords.some(k => rawQuery.includes(k))) {
        score += 0.2;
      }

      if (score > highestScore) {
        highestScore = score;
        bestMatch = entry;
      }
    }

    highestScore = Math.min(highestScore, 0.99);

    return {
      bestMatch,
      confidence: highestScore
    };
  }
}

const knowledgeService = new KnowledgeService();
module.exports = knowledgeService;
