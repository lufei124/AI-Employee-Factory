import eslintPlugin from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.worktrees/**'],
  },
  {
    files: [
      'src/**/*.ts',
      'web/**/*.ts',
      'web/**/*.tsx',
      'tests/**/*.ts',
      'tests/**/*.tsx',
      'e2e/**/*.ts',
      'playwright.config.ts',
      'vitest.config.ts',
    ],
    languageOptions: {
      parser,
      parserOptions: {
        project: ['./tsconfig.eslint.json', './tsconfig.web.json'],
        sourceType: 'module',
      },
    },
    plugins: { '@typescript-eslint': eslintPlugin },
    rules: {
      ...eslintPlugin.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
