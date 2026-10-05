const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
module.exports = tseslint.config(
  { ignores: ['out/**', 'node_modules/**', 'runners/**', 'media/**', 'examples/**', 'scripts/**', '*.vsix'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always']
    }
  }
);
