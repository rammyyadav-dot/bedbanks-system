// Fails when the migrated database differs from prisma/schema.prisma.
// Prisma 6 cannot declare pgvector HNSW indexes, so the one index created by
// migration 202610010003_hotel_search_index is the only tolerated difference.
import { spawnSync } from 'node:child_process'

const TOLERATED = new Set(['DROP INDEX "HotelSearchIndex_embedding_hnsw";'])

const diff = spawnSync(
  'pnpm',
  ['exec', 'prisma', 'migrate', 'diff', '--from-url', process.env.DATABASE_URL ?? '', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
  { encoding: 'utf8' },
)
if (diff.status !== 0) {
  process.stderr.write(diff.stderr)
  process.exit(diff.status ?? 1)
}

const statements = diff.stdout
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('--'))
const unexpected = statements.filter((line) => !TOLERATED.has(line))
if (unexpected.length > 0) {
  console.error('Schema drift between migrations and prisma/schema.prisma:\n' + unexpected.join('\n'))
  process.exit(2)
}
console.log('No schema drift.')
