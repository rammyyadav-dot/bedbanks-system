import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';

const files = globSync(resolve(process.cwd(), 'packages/connectors/**/*.ts'));
const violations: string[] = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/catch[\s\S]{0,300}?return[\s\S]{0,120}?(demo|mock|stale|totalMinor:\s*0)/gi)) {
    violations.push(`${file}: silent supplier fallback near offset ${match.index ?? 0}`);
  }
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(`No silent connector fallbacks found in ${files.length} file(s).`);
