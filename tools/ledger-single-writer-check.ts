import { readFileSync, globSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/**
 * ADR 0056: the API appends to LedgerEntry only through apps/api/src/ledger/ledger-core.ts, and computes a wallet balance only through it.
 * Specs are exempt (they mock the client). Reads that list entries (findMany) are unrestricted; sums and writes are not.
 */
const root = process.cwd();
const core = resolve(root, 'apps/api/src/ledger/ledger-core.ts');
const files = globSync(resolve(root, 'apps/api/src/**/*.ts')).filter((f) => !f.endsWith('.spec.ts') && f !== core);
const forbidden: Array<[RegExp, string]> = [
  [/\.ledgerEntry\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/, 'writes LedgerEntry directly; use appendLedgerEntry'],
  [/\.ledgerEntry\.(aggregate|groupBy)\s*\(/, 'sums LedgerEntry directly; use walletBalanceMinor / walletTotals'],
];
const violations: string[] = [];
for (const file of files) {
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    for (const [pattern, why] of forbidden) if (pattern.test(line)) violations.push(`${relative(root, file)}:${index + 1}: ${why}`);
  });
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(`Ledger single-writer rule holds in ${files.length} API file(s).`);
