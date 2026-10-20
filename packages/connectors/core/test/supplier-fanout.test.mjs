import test from 'node:test'
import assert from 'node:assert/strict'
import { fanOutRead } from '../src/fanout/supplier-fanout.ts'
import { InProcessGate } from '../src/xml/xml-transport.ts'
import { SupplierCallError } from '../src/xml/supplier-types.ts'

const search = { name: 'search', kind: 'read' }
const options = (extra = {}) => ({ operation: search, correlationId: 'req-1', deadlineMs: 200, ...extra })
const leg = (id, call, extra = {}) => ({ supplierId: `supplier-${id}`, connectorId: `connector-${id}`, gate: new InProcessGate(), call, ...extra })
const never = () => new Promise(() => {})

test('all suppliers answer: every leg ok and counted', async () => {
  const result = await fanOutRead([leg('a', async () => ['a1']), leg('b', async () => ['b1'])], options())
  assert.deepEqual(result.summary, { queried: 2, succeeded: 2, failed: 0, degraded: 0 })
  assert.deepEqual(result.legs.map((l) => [l.status, l.value]), [['ok', ['a1']], ['ok', ['b1']]])
})

test('a supplier that ignores the abort signal is abandoned at its own timeout, and the others still answer', async () => {
  let aborted = false
  const slow = leg('slow', (signal) => { signal.addEventListener('abort', () => { aborted = true }); return never() }, { timeoutMs: 30 })
  const started = Date.now()
  const result = await fanOutRead([slow, leg('fast', async () => ['f1'])], options({ deadlineMs: 1_000 }))
  assert.ok(Date.now() - started < 500, 'must not wait for the overall deadline')
  assert.equal(aborted, true)
  assert.deepEqual(result.legs.map((l) => [l.supplierId, l.status, l.failure]), [['supplier-slow', 'failed', 'timeout'], ['supplier-fast', 'ok', undefined]])
  assert.deepEqual(result.summary, { queried: 2, succeeded: 1, failed: 1, degraded: 0 })
})

test('the overall deadline caps a generous leg timeout', async () => {
  const started = Date.now()
  const result = await fanOutRead([leg('a', never, { timeoutMs: 10_000 })], options({ deadlineMs: 40 }))
  assert.ok(Date.now() - started < 500)
  assert.equal(result.legs[0].failure, 'timeout')
})

test('repeated provider failures open the circuit, and an open circuit never calls the supplier', async () => {
  const gate = new InProcessGate({ failureThreshold: 2, openMs: 60_000 })
  let calls = 0
  const failing = () => leg('a', async () => { calls++; throw new SupplierCallError('provider_unavailable', 'answered') }, { gate })
  await fanOutRead([failing()], options())
  await fanOutRead([failing()], options())
  const result = await fanOutRead([failing()], options())
  assert.equal(calls, 2)
  assert.equal(result.legs[0].failure, 'circuit_open')
  assert.equal(gate.snapshot().active, 0, 'every acquired slot is released')
})

test('a declared fallback answers a failed leg, tagged as fallback and still counted as failed', async () => {
  const content = leg('a', async () => { throw new SupplierCallError('timeout', 'answered') }, { fallback: async (failure) => ({ published: true, failure }) })
  const result = await fanOutRead([content], options())
  assert.equal(result.legs[0].status, 'fallback')
  assert.deepEqual(result.legs[0].value, { published: true, failure: 'timeout' })
  assert.deepEqual(result.summary, { queried: 1, succeeded: 0, failed: 1, degraded: 1 })
})

test('without a declared fallback a failed leg contributes nothing', async () => {
  const result = await fanOutRead([leg('a', async () => { throw new Error('socket hang up') })], options())
  assert.equal(result.legs[0].status, 'failed')
  assert.equal(result.legs[0].failure, 'transport')
  assert.equal('value' in result.legs[0], false)
})

test('a fallback that throws, returns null or overruns the deadline leaves the leg failed', async () => {
  const fail = async () => { throw new SupplierCallError('provider_unavailable', 'answered') }
  const result = await fanOutRead([
    leg('a', fail, { fallback: async () => { throw new Error('cache down') } }),
    leg('b', fail, { fallback: async () => null }),
    leg('c', fail, { fallback: never }),
  ], options({ deadlineMs: 50 }))
  assert.deepEqual(result.legs.map((l) => l.status), ['failed', 'failed', 'failed'])
})

test('caller cancellation stops every leg, is reported as cancelled, does not use fallbacks and does not trip the circuit', async () => {
  const gate = new InProcessGate({ failureThreshold: 1 })
  const controller = new AbortController()
  let fallbackCalled = false
  setTimeout(() => controller.abort(), 10)
  const result = await fanOutRead([leg('a', never, { gate, fallback: async () => { fallbackCalled = true; return 1 } })], options({ signal: controller.signal, deadlineMs: 1_000 }))
  assert.equal(result.legs[0].failure, 'cancelled')
  assert.equal(fallbackCalled, false)
  assert.equal(gate.snapshot().circuitOpen, false)
})

test('a late answer after the deadline is discarded', async () => {
  const result = await fanOutRead([leg('a', () => new Promise((resolve) => setTimeout(() => resolve('late'), 80)), { timeoutMs: 20 })], options())
  assert.equal(result.legs[0].status, 'failed')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(result.legs[0].status, 'failed')
})

test('mutations are never fanned out', async () => {
  await assert.rejects(fanOutRead([leg('a', async () => 1)], options({ operation: { name: 'book', kind: 'mutation' } })), (e) => e.code === 'unsupported')
})

test('configuration is validated before any supplier is called', async () => {
  let called = false
  const call = async () => { called = true; return 1 }
  await assert.rejects(fanOutRead([leg('a', call)], options({ correlationId: 'bad id\r\n' })), (e) => e.code === 'configuration')
  await assert.rejects(fanOutRead([leg('a', call)], options({ deadlineMs: 0 })), (e) => e.code === 'configuration')
  await assert.rejects(fanOutRead([leg('a', call), leg('a', call)], options()), (e) => e.code === 'configuration')
  assert.equal(called, false)
})

test('events carry ids, codes and timings only, and a throwing sink cannot fail the search', async () => {
  const events = []
  const sink = (event) => { events.push(event); throw new Error('sink down') }
  const result = await fanOutRead([
    leg('a', async () => ({ guest: 'Jane Doe', token: 'secret-token' })),
    leg('b', async () => { throw new SupplierCallError('authentication', 'answered') }),
  ], options({ event: sink }))
  assert.equal(result.summary.succeeded, 1)
  assert.deepEqual(events.map((e) => Object.keys(e).sort()), Array(2).fill(['connectorId', 'correlationId', 'durationMs', 'fallbackUsed', 'operation', 'outcome', 'supplierId']))
  assert.deepEqual(events.map((e) => e.outcome), ['success', 'authentication'])
  assert.doesNotMatch(JSON.stringify(events), /Jane|secret-token/)
})
