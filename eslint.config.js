import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'docs/**', 'src-tauri/**'] },
  { files: ['**/*.{ts,tsx}'], extends: [js.configs.recommended, ...tseslint.configs.recommended] },
  { files: ['scripts/**/*.mjs'], extends: [js.configs.recommended], languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly', performance: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } } },
);
