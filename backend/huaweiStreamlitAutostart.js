/**
 * Optional: start Huawei GoDam-1.0 Streamlit alongside Express so one process runs
 * Node API + Python Streamlit (dev or production VPS when explicitly enabled).
 *
 * Enable with HUAWEI_GODAM_STREAMLIT_AUTOSTART=1 (./dev.sh / npm run dev:web:huawei).
 * To skip Streamlit on production hosts: HUAWEI_GODAM_STREAMLIT_DISABLE_PRODUCTION=1
 *
 * Matcher jobs still run via Python from /api/huawei-godam/batches — unchanged.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveGoDamPluginDir } = require('./godamPluginPaths');

let streamlitChild = null;

function repoRoot() {
  return path.join(__dirname, '..');
}

function startHuaweiStreamlitIfEnabled() {
  if (process.env.HUAWEI_GODAM_STREAMLIT_AUTOSTART !== '1') return;
  const disableProd =
    String(process.env.HUAWEI_GODAM_STREAMLIT_DISABLE_PRODUCTION || '').trim() === '1';
  if (disableProd && String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.warn('[huawei] Streamlit autostart skipped (HUAWEI_GODAM_STREAMLIT_DISABLE_PRODUCTION=1).');
    return;
  }
  const root = repoRoot();
  const script = path.join(root, 'scripts', 'run-huawei-godam-streamlit.sh');
  const godamDir = resolveGoDamPluginDir(root);
  if (!fs.existsSync(script) || !godamDir) {
    console.warn(
      '[huawei] Streamlit autostart skipped (missing GoDam-1.0). Expected plugins/GoDam-1.0 (canonical) or legacy GoDam/GoDam-1.0 — run npm run setup:huawei-godam'
    );
    return;
  }
  if (streamlitChild && !streamlitChild.killed) return;

  console.log('[huawei] Starting Streamlit (GoDam-1.0) as child of Node — same API :3001');
  streamlitChild = spawn('bash', [script], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env },
    detached: false,
  });
  streamlitChild.on('exit', (code, sig) => {
    streamlitChild = null;
    if (code !== 0 && sig !== 'SIGTERM' && sig !== 'SIGINT') {
      console.warn(`[huawei] Streamlit exited (code=${code}, signal=${sig || 'none'})`);
    }
  });
}

function stopHuaweiStreamlit() {
  if (!streamlitChild || streamlitChild.killed) return;
  try {
    streamlitChild.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

function registerLifecycleHooks() {
  const onStop = () => {
    stopHuaweiStreamlit();
  };
  process.on('SIGINT', () => {
    onStop();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    onStop();
    process.exit(143);
  });
  process.on('SIGUSR2', () => {
    onStop();
  });
}

module.exports = {
  startHuaweiStreamlitIfEnabled,
  stopHuaweiStreamlit,
  registerLifecycleHooks,
};
