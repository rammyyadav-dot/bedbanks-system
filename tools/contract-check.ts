import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
// routes.ts composes the Agent's routes from agent-routes.ts (ADR 0075), so both files are the route source.
const routeSource = ['routes.ts', 'agent-routes.ts'].map((file) => readFileSync(resolve(root, 'packages/contracts/src', file), 'utf8')).join('\n');
const controllers = globSync(resolve(root, 'apps/api/src/**/*.controller.ts'));
const missing: string[] = [];

for (const file of controllers) {
  const source = readFileSync(file, 'utf8');
  const controller = source.match(/@Controller\('([^']+)'\)/)?.[1];
  if (!controller) continue;
  for (const match of source.matchAll(/@(Get|Post|Put|Delete|Patch)\((?:'([^']*)')?\)/g)) {
    const path = `/${controller}${match[2] ? `/${match[2]}` : ''}`;
    if (!routeSource.includes(`'${path}'`)) missing.push(`${file.replace(`${root}/`, '')}: ${path}`);
  }
}

if (missing.length) {
  console.error('API routes missing from @bedbanks/contracts:');
  console.error(missing.join('\n'));
  process.exit(1);
}
console.log(`Contract check passed for ${controllers.length} controller(s).`);
