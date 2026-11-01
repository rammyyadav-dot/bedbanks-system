import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cookieProblems, dubaiSearchBody, leakedPatterns, normaliseTarget, runSmoke } from './hosted-agent-smoke.mjs'

test('the target must be an https bare origin (http only for localhost when allowed)', () => {
  assert.equal(normaliseTarget('https://agent.example.com'), 'https://agent.example.com')
  for (const bad of ['http://agent.example.com', 'https://u:p@agent.example.com', 'https://agent.example.com/login', 'https://agent.example.com/?x=1', 'agent.example.com', '']) assert.throws(() => normaliseTarget(bad), /HOSTED_AGENT_URL/)
  assert.throws(() => normaliseTarget('http://localhost:3003'), /https/)
  assert.equal(normaliseTarget('http://localhost:3003', { allowLocalHttp: true }), 'http://localhost:3003')
  assert.throws(() => normaliseTarget('http://agent.example.com', { allowLocalHttp: true }), /https/)
})

test('session cookie problems are named', () => {
  assert.deepEqual(cookieProblems('fbeds_session=x; Path=/; HttpOnly; Secure; SameSite=Lax'), [])
  assert.deepEqual(cookieProblems('fbeds_session=x; Path=/; HttpOnly; SameSite=Lax', { hosted: false }), [])
  const bad = cookieProblems('s=x; Domain=.example.com; SameSite=None')
  assert.ok(bad.some((p) => /HttpOnly/.test(p)) && bad.some((p) => /Secure/.test(p)) && bad.some((p) => /Domain/.test(p)) && bad.some((p) => /None/.test(p)))
  assert.deepEqual(cookieProblems(null), ['no session cookie was set'])
})

test('server-only names and connection strings are detected without echoing a value', () => {
  assert.deepEqual(leakedPatterns('plain marketing text'), [])
  assert.ok(leakedPatterns('x postgresql://user:pw@h/db y').length === 1)
  assert.ok(leakedPatterns('API_INTERNAL_URL=https://x').length === 1)
})

test('the search body is the canonical Dubai one-room two-adult AED request', () => {
  const b = dubaiSearchBody('2030-01-01', '2030-01-03')
  assert.deepEqual([b.destinationRef.id, b.rooms, b.adults, b.currency], ['city:AE:dubai', 1, 2, 'AED'])
})

test('the smoke fails closed against an API that serves nothing useful, and never prints credentials', async () => {
  const logs = []
  const fetchImpl = async () => new Response('nope', { status: 500 })
  const out = await runSmoke({ origin: 'https://agent.example.com', email: 'a@b.c', password: 'super-secret-pw', fetchImpl, log: (l) => logs.push(l) })
  assert.equal(out.ok, false)
  assert.ok(!logs.join('\n').includes('super-secret-pw'))
  assert.ok(out.results.some((r) => r.name.startsWith('H1') && !r.ok))
})
