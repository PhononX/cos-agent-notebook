import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'test/fixtures/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': 'error',
    },
  },
  {
    // Tests spell out notebook lines, where the exact spaces are the point.
    files: ['test/**/*.ts'],
    rules: { 'no-regex-spaces': 'off' },
  },
  {
    files: ['src/cli/**/*.ts', 'evals/run.ts', 'eslint.config.js'],
    rules: { 'no-console': 'off' },
  },
)
