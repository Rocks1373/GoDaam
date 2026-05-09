const fs = require('fs');
const path = require('path');

const ROOT_FALLBACK = path.resolve(__dirname, '..', '..', 'SYSTEM_WORKFLOW_AND_DATABASE_AUDIT.txt');
const KNOWLEDGE_DIR = path.resolve(__dirname, '..', 'ai_knowledge');
const KNOWLEDGE_FILE = path.resolve(KNOWLEDGE_DIR, 'system_workflow_and_database_audit.txt');

function ensureKnowledgeFilePresent() {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    if (fs.existsSync(KNOWLEDGE_FILE)) return { ok: true, path: KNOWLEDGE_FILE, created: false };
    if (fs.existsSync(ROOT_FALLBACK)) {
      fs.copyFileSync(ROOT_FALLBACK, KNOWLEDGE_FILE);
      return { ok: true, path: KNOWLEDGE_FILE, created: true, from: ROOT_FALLBACK };
    }
    fs.writeFileSync(
      KNOWLEDGE_FILE,
      'SYSTEM WORKFLOW AND DATABASE AUDIT\n\n(Missing source file. Please add content here.)\n',
      'utf8'
    );
    return { ok: true, path: KNOWLEDGE_FILE, created: true, from: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

let cache = { mtimeMs: 0, text: '', lastLoadAt: 0 };

function readKnowledgeCached({ maxChars = 120_000 } = {}) {
  ensureKnowledgeFilePresent();
  try {
    const st = fs.statSync(KNOWLEDGE_FILE);
    if (st.mtimeMs !== cache.mtimeMs) {
      const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');
      cache = {
        mtimeMs: st.mtimeMs,
        text: raw.slice(0, Math.max(1000, maxChars)),
        lastLoadAt: Date.now(),
      };
    }
    return { ok: true, path: KNOWLEDGE_FILE, mtimeMs: cache.mtimeMs, text: cache.text };
  } catch (e) {
    return { ok: false, error: e.message, path: KNOWLEDGE_FILE };
  }
}

function getKnowledgeStatus() {
  const ensured = ensureKnowledgeFilePresent();
  try {
    const st = fs.existsSync(KNOWLEDGE_FILE) ? fs.statSync(KNOWLEDGE_FILE) : null;
    return {
      ok: true,
      ensured,
      path: KNOWLEDGE_FILE,
      exists: Boolean(st),
      sizeBytes: st?.size || 0,
      updatedAt: st?.mtime ? st.mtime.toISOString() : null,
      cachedAt: cache.lastLoadAt ? new Date(cache.lastLoadAt).toISOString() : null,
    };
  } catch (e) {
    return { ok: false, ensured, error: e.message };
  }
}

module.exports = {
  KNOWLEDGE_FILE,
  ensureKnowledgeFilePresent,
  readKnowledgeCached,
  getKnowledgeStatus,
};

