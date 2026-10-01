import { access, cp, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'apps/website/.next');
const destination = path.join(root, '.next');

async function main(): Promise<void> {
  await access(path.join(source, 'BUILD_ID'));
  await access(path.join(source, 'routes-manifest.json'));
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  await access(path.join(destination, 'BUILD_ID'));
  await access(path.join(destination, 'routes-manifest.json'));
  console.log('Published apps/website/.next to the repository root .next directory.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
