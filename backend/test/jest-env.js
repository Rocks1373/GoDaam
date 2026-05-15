/** Runs before any test file — ensures auth preflight passes when DATABASE_URL is set. */
if (!process.env.JWT_SECRET || String(process.env.JWT_SECRET).length < 32) {
  process.env.JWT_SECRET = 'test'.repeat(16); // 64 chars, not a known placeholder
}
