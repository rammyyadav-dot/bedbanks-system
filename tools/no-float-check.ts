import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';

const roots = ['packages/money/src', 'packages/pricing/src', 'apps/api/src/pricing', 'apps/api/src/finance'];
const files = roots.flatMap((path) => globSync(resolve(process.cwd(), `${path}/**/*.ts`)));
const violations: string[] = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    if (/\b\d+\.\d+\b/.test(line)) violations.push(`${file}:${index + 1}: decimal literal in money path`);
  });
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(`No floating-point literals found in ${files.length} money-path file(s).`);
