import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distLogo = path.join(__dirname, '..', 'dist', 'LOGO.png');
// Repo .cursor exists only on dev host (Docker build context is frontend/ only — no ../../.cursor).
const logDir = path.join(__dirname, '..', '..', '.cursor');
const logPath = fs.existsSync(logDir) ? path.join(logDir, 'debug-4a59d0.log') : null;

function append(line) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(line) + '\n');
}

const sessionId = '4a59d0';
const ts = Date.now();

try {
  const st = fs.statSync(distLogo);
  const mode = (st.mode & parseInt('777', 8)).toString(8);
  append({
    sessionId,
    hypothesisId: 'A',
    location: 'verify-logo-for-debug.mjs',
    message: 'dist/LOGO.png exists after vite build',
    data: { exists: true, size: st.size, modeOctal: mode, worldReadable: (st.mode & parseInt('044', 8)) === parseInt('044', 8) },
    timestamp: ts,
    runId: 'build-verify',
  });
} catch (e) {
  append({
    sessionId,
    hypothesisId: 'A',
    location: 'verify-logo-for-debug.mjs',
    message: 'dist/LOGO.png missing',
    data: { exists: false, error: String(e?.message || e) },
    timestamp: ts,
    runId: 'build-verify',
  });
}
