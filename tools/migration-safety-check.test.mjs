import assert from 'node:assert/strict'
import test from 'node:test'
import { checkMigration, evaluate, unindexedForeignKeys } from './migration-safety-check.mjs'

const rules = (sql) => checkMigration('m', sql).map((p) => /\[([\w-]+)\]/.exec(p)[1])

test('flags destructive and lock-heavy statements', () => {
  assert.deepEqual(rules('DROP TABLE "A";'), ['drop-table'])
  assert.deepEqual(rules('ALTER TABLE "A" DROP COLUMN "x";'), ['drop-column'])
  assert.deepEqual(rules('ALTER TABLE "A" ALTER COLUMN "x" SET NOT NULL;'), ['set-not-null'])
  assert.deepEqual(rules('ALTER TABLE "A" ALTER COLUMN "x" TYPE BIGINT;'), ['alter-type'])
  assert.deepEqual(rules('ALTER TABLE "A" RENAME COLUMN "x" TO "y";'), ['rename'])
  assert.deepEqual(rules('UPDATE "A" SET "x" = 1;'), ['unbounded-write'])
  assert.deepEqual(rules('DELETE FROM "A";'), ['unbounded-write'])
})
test('accepts bounded writes and additive changes', () => {
  assert.deepEqual(rules('UPDATE "A" SET "x" = 1 WHERE "y" IS NULL;\nALTER TABLE "A" ADD COLUMN "z" TEXT;'), [])
})
test('an allow marker with a reason exempts a statement; without a reason it does not', () => {
  assert.deepEqual(rules('-- migration-safety: allow drop-column column was never populated in production\nALTER TABLE "A" DROP COLUMN "x";'), [])
  assert.deepEqual(rules('-- migration-safety: allow drop-column\nALTER TABLE "A" DROP COLUMN "x";'), ['drop-column'])
})
test('index builds: free on a table created in the same migration, blocking otherwise', () => {
  assert.deepEqual(rules('CREATE TABLE "N" ("id" TEXT);\nCREATE INDEX "N_id_idx" ON "N"("id");'), [])
  assert.deepEqual(rules('CREATE INDEX "B_id_idx" ON "B"("id");'), ['create-index-blocking'])
})
test('flags a credential literal in a role statement but not a psql variable', () => {
  assert.deepEqual(rules("CREATE ROLE app LOGIN PASSWORD 'hunter2hunter2';"), ['raw-secret'])
  assert.deepEqual(rules('CREATE ROLE app NOLOGIN;'), [])
})
test('ignores keywords inside comments and string literals', () => {
  assert.deepEqual(rules("-- DROP TABLE x\n/* TRUNCATE a; */\nINSERT INTO \"A\" (\"n\") VALUES ('DROP TABLE');"), [])
})
test('finds foreign keys with no leading index', () => {
  const schema = `model A {\n  id String @id\n  bId String\n  cId String\n  b B @relation(fields: [bId], references: [id])\n  c C @relation(fields: [cId], references: [id])\n  @@index([cId, bId])\n}\n`
  assert.deepEqual(unindexedForeignKeys(schema), ['A.bId'])
  assert.deepEqual(unindexedForeignKeys(schema.replace('@@index([cId, bId])', '@@index([bId])\n  @@unique([cId])')), [])
})
test('baseline entries are accepted and stale ones are rejected', () => {
  const schema = 'model A {\n  id String @id\n  bId String\n  b B @relation(fields: [bId], references: [id])\n}\n'
  assert.deepEqual(evaluate({ schema, baseline: { unindexedForeignKeys: ['A.bId'] }, migrations: {} }), [])
  assert.equal(evaluate({ schema, baseline: {}, migrations: {} }).length, 1)
  assert.equal(evaluate({ schema: 'model A {\n  id String @id\n}\n', baseline: { unindexedForeignKeys: ['A.bId'] }, migrations: {} }).length, 1)
})
