import { readFileSync } from 'node:fs';
import tseslint from 'typescript-eslint';

// Files that already contain audited unsafe raw SQL (DDL and role administration); the same list gates tools/raw-sql-check.ts.
const rawSqlBaseline = Object.keys(JSON.parse(readFileSync(new URL('./security/raw-sql-baseline.json', import.meta.url), 'utf8')));
const TEST_FILES = ['**/*.spec.ts', '**/*.test.ts', '**/*.e2e-spec.ts', '**/test/**', '**/tests/**', 'e2e/**'];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/coverage/**', '**/next-env.d.ts'] },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}', 'tools/**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-debugger': 'error',
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    // Burn-down: new `any` shows up as a warning in production code. Tests may still use it.
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: ['**/*.spec.ts', '**/*.test.ts', '**/*.e2e-spec.ts', '**/test/**', 'e2e/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'warn' },
  },
  {
    // SQL injection guard: values reach PostgreSQL as bind parameters only (tagged template or Prisma.sql). Hand-built SQL text is an error.
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: [...TEST_FILES, ...rawSqlBaseline],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name=/^\\$(query|execute)RawUnsafe$/]", message: 'Unsafe raw SQL sends text to PostgreSQL unparameterised. Use $queryRaw`...${value}` or Prisma.sql. For DDL on constant identifiers add "// eslint-disable-next-line no-restricted-syntax -- raw-sql: <reason>".' },
        { selector: "CallExpression[callee.object.name='Prisma'][callee.property.name='raw']", message: 'Prisma.raw embeds text into SQL unescaped. Use Prisma.sql with bound values, or Prisma.join for lists.' },
        { selector: "CallExpression[callee.property.name=/^\\$(query|execute)Raw$/][arguments.0.type=/^(TemplateLiteral|Literal|BinaryExpression)$/]", message: 'Pass Prisma.sql`...` (or use the tagged-template form); a string or template literal is SQL text built by hand.' },
      ],
    },
  },
);
