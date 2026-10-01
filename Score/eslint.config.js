// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.generated.ts',
      'apps/web/public/**',
      'out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Pure packages must stay free of DOM and Node APIs so they run in the browser, Web Workers,
    // Node CLIs and tests alike. (packages/tsconfig.json also omits the DOM lib.)
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/*/src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Pure packages must not touch the DOM.' },
        { name: 'document', message: 'Pure packages must not touch the DOM.' },
        { name: 'localStorage', message: 'Persistence belongs to apps/web.' },
        { name: 'navigator', message: 'Pure packages must not touch the DOM.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'react', 'react-dom'],
              message: 'Pure packages must not import Node or UI modules.',
            },
          ],
        },
      ],
    },
  },
);
