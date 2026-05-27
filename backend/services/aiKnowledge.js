const fs = require('fs');
const path = require('path');

const ROOT_FALLBACK = path.resolve(__dirname, '..', '..', 'SYSTEM_WORKFLOW_AND_DATABASE_AUDIT.txt');
const KNOWLEDGE_DIR = path.resolve(__dirname, '..', 'ai_knowledge');
const KNOWLEDGE_FILE = path.resolve(KNOWLEDGE_DIR, 'system_workflow_and_database_audit.txt');
const MEMORY_FILE = path.resolve(KNOWLEDGE_DIR, 'godam_ai_memory.md');
const TRAINING_GUIDE_FILE = path.resolve(KNOWLEDGE_DIR, 'godam_ai_training_guide.md');

const DEFAULT_MEMORY = `# GoDam AI Memory

Purpose:
This file gives the GoDam AI assistant stable, non-secret memory about Deepak's application, workflows, safety rules, and operating style.

Core identity:
- Main project: GoDam warehouse system, also called GAPP in some places.
- Production host: Hostinger VPS.
- Main areas: backend API, frontend web admin, mobile app, database, AI plugin, Huawei matching module, notifications, SAP/logistics automation, deployment.
- Preferred answers: short, clear, practical, step-by-step diagnosis.

Safety:
- Never reveal .env values, API keys, database passwords, JWT secrets, tokens, or private credentials.
- Never delete or move files without explicit approval.
- Never overwrite important config without backup and approval.
- Never modify production database without backup and approval.
- Never deploy, commit, push, or restart production services unless Deepak asks or approves.
- Normal code edits need one-time approval before starting; after approval continue until complete.

Application map:
- frontend/: React/Vite web admin.
- backend/: Express API, auth, permissions, stock, outbound, delivery, notifications, reports.
- godam-mobile/: Expo/React Native mobile app (canonical).
- ai_plugin/: Python FastAPI AI tool service used by backend /api/ai.
- backend/ai_knowledge/: non-secret AI memory and workflow knowledge.
- Huawei module: upload and matching workflow for VCast/accessories/PO/SO/summary/DN and Excel outputs.

Default diagnostic behavior:
- Inspect before fixing.
- Show root cause, affected area, safe fix, and test steps.
- Prefer read-only checks first.
- Use reports and database checks before suggesting edits.
- If a request is vague, ask only what blocks the job.

AI provider notes:
- Production can use local Ollama through AI_PROVIDER=ollama.
- Ollama runs locally on 127.0.0.1:11434 and must not be exposed publicly.
- Local model responses may be slower on CPU.
`;

function ensureKnowledgeFilePresent() {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, DEFAULT_MEMORY, 'utf8');
    // Training guide is optional at bootstrap; created by deploy/maintainers.
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
      const memory = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8') : '';
      const training = fs.existsSync(TRAINING_GUIDE_FILE) ? fs.readFileSync(TRAINING_GUIDE_FILE, 'utf8') : '';
      const audit = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');
      const raw = [
        '## STABLE MEMORY',
        memory,
        '## AI TRAINING GUIDE (OPERATIONS & USER SUPPORT)',
        training,
        '## WORKFLOW AND DATABASE AUDIT',
        audit,
      ].join('\n\n');
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
      memoryPath: MEMORY_FILE,
      trainingGuidePath: TRAINING_GUIDE_FILE,
      trainingGuideExists: fs.existsSync(TRAINING_GUIDE_FILE),
      exists: Boolean(st),
      memoryExists: fs.existsSync(MEMORY_FILE),
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
