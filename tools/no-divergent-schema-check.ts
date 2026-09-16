import { globSync } from 'node:fs';

const schemas = globSync('**/schema.prisma', {
  cwd: process.cwd(),
  exclude: ['**/node_modules/**'],
}).sort();

if (schemas.length !== 1) {
  console.error('Schema source-of-truth check failed.');
  console.error(`Expected exactly one Prisma schema outside node_modules, but found ${schemas.length}.`);
  for (const schema of schemas) console.error(`- ${schema}`);
  console.error('Keep only apps/api/prisma/schema.prisma. A second schema can generate an incompatible Prisma Client and split migration history.');
  process.exit(1);
}

if (schemas[0] !== 'apps/api/prisma/schema.prisma') {
  console.error('Schema source-of-truth check failed.');
  console.error(`Expected apps/api/prisma/schema.prisma, but found ${schemas[0]}.`);
  process.exit(1);
}

console.log(`Schema source-of-truth check passed: ${schemas[0]}`);
