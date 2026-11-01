import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate, scan } from './raw-sql-check.ts'

const run = (code: string, baseline: Record<string, number> = {}) => evaluate({ 'a.ts': scan('a.ts', code) }, baseline)

test('accepts tagged templates and Prisma.sql', () => {
  assert.deepEqual(run('await tx.$queryRaw`SELECT 1 WHERE id = ${id}`; await tx.$executeRaw(Prisma.sql`UPDATE t SET a = ${b}`); await tx.$executeRaw(build(x))'), [])
})
test('flags hand-built SQL passed to $queryRaw', () => {
  assert.equal(run('await tx.$queryRaw(`SELECT * FROM t WHERE id = ${id}`)').length, 1)
  assert.equal(run('await tx.$executeRaw("DELETE FROM t WHERE id = " + id)').length, 1)
})
test('flags an unsafe call that is not baselined', () => {
  const [problem] = run('await db.$queryRawUnsafe(`SELECT * FROM t WHERE a = ${input}`)')
  assert.match(problem!, /interpolated/)
  assert.equal(run('await db.$executeRawUnsafe("SELECT 1")').length, 1)
  assert.equal(run('Prisma.raw(x)').length, 1)
})
test('an audited marker or a baseline entry allows an unsafe call', () => {
  assert.deepEqual(run('// raw-sql: GRANT takes an identifier from a constant\nawait db.$executeRawUnsafe(`GRANT ${ROLE}`)'), [])
  assert.deepEqual(run('await db.$executeRawUnsafe(`GRANT ${ROLE}`)', { 'a.ts': 1 }), [])
})
test('a marker needs a reason', () => assert.equal(run('// raw-sql:\nawait db.$executeRawUnsafe(`GRANT ${ROLE}`)').length, 1))
test('baseline cannot be exceeded or left stale', () => {
  assert.equal(run('await db.$executeRawUnsafe(a); await db.$executeRawUnsafe(b)', { 'a.ts': 1 }).length, 2)
  assert.match(run('await db.$executeRaw`SELECT 1`', { 'a.ts': 1 })[0]!, /lower the baseline/)
})
