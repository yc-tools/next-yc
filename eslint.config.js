const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'examples/**', 'docs/**'],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['packages/*/src/**/*.ts'],
  })),
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      // Existing code intentionally uses `any` in a few interop spots
      // (marked with inline eslint-disable comments); keep the rule on but
      // allow underscore-prefixed unused args to match current style.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
);
