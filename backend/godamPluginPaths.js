const fs = require('fs');
const path = require('path');

/**
 * Repo may ship GoDam-1.0 under GoDam/GoDam-1.0 or plugins/GoDam-1.0.
 */
function resolveGoDamPluginDir(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'GoDam', 'GoDam-1.0'),
    path.join(repoRoot, 'plugins', 'GoDam-1.0'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'Home.py'))) return dir;
  }
  return null;
}

module.exports = { resolveGoDamPluginDir };
