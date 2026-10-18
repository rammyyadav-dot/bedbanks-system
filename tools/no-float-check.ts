import { existsSync, readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';

// Directories that compute, store or move money. A root that no longer exists fails the check, so a
// rename or move cannot silently shrink coverage.
const roots = [
  'packages/money/src',
  'packages/pricing/src',
  'apps/api/src/ledger',
  'apps/api/src/booking-ops',
  'apps/api/src/commercial',
  'apps/api/src/funding',
  'apps/api/src/supply',
];
// Display-only text (never arithmetic) may opt out one line at a time with this marker.
const allowMarker = 'no-float-check: display-only';

const missing = roots.filter((path) => !existsSync(resolve(process.cwd(), path)));
if (missing.length) {
  console.error(`Money-path roots not found (update tools/no-float-check.ts): ${missing.join(', ')}`);
  process.exit(1);
}
const files = roots
  .flatMap((path) => globSync(resolve(process.cwd(), `${path}/**/*.ts`)))
  .filter((file) => !file.endsWith('.spec.ts'));
const violations: string[] = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    if (/\b\d+\.\d+\b/.test(line) && !line.includes(allowMarker)) violations.push(`${file}:${index + 1}: decimal literal in money path`);
  });
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(`No floating-point literals found in ${files.length} money-path file(s).`);
