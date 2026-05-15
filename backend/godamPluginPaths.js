const fs = require('fs');
const path = require('path');

/**
 * Canonical GoDam 1.0 (Streamlit) tree: **plugins/GoDam-1.0**.
 * Legacy fallback: GoDam/GoDam-1.0 (checked second).
 */
function resolveGoDamPluginDir(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'plugins', 'GoDam-1.0'),
    path.join(repoRoot, 'GoDam', 'GoDam-1.0'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'Home.py'))) return dir;
  }
  return null;
}

module.exports = { resolveGoDamPluginDir };
