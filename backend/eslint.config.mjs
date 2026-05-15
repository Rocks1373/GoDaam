import js from '@eslint/js';
import globals from 'globals';
import n from 'eslint-plugin-n';
import security from 'eslint-plugin-security';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    plugins: { n, security },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'n/no-unsupported-features/node-builtins': 'off',
      'security/detect-object-injection': 'off',
    },
  },
];
