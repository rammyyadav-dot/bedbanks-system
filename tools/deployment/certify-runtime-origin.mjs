// ADR 0055 certification: ONE built artifact per portal, run in two configurations with different API origins, without rebuilding.
// Needs the standalone builds (NEXT_OUTPUT=standalone pnpm exec turbo run build --filter=<portal>). Uses only local loopback processes.
// It certifies the artifact tree, NOT a container image digest: that needs Docker (see docs/aws-wp3-verification-evidence.md).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../../', import.meta.url).pathname
const APPS = { agent: {}, admin: { AUTH_API_ORIGIN: 'http://127.0.0.1:3001' }, supplier: { SUPPLIER_ORIGIN: 'http://127.0.0.1:3003' } }
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`) }

const lstatIsLink = (f) => { try { readlinkSync(f); return true } catch { return false } }
function treeDigest(dir) {
  const files = []
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isSymbolicLink()) files.push(p); else if (e.isDirectory()) walk(p); else files.push(p) } }
  walk(dir)
  const h = createHash('sha256')
  // pnpm leaves symlinks in the traced node_modules: hash the link target (not the pointee) so the digest stays deterministic.
  for (const f of files.sort()) h.update(relative(dir, f)).update('\0').update(lstatIsLink(f) ? `link:${readlinkSync(f)}` : readFileSync(f)).update('\0')
  return { sha256: h.digest('hex'), files: files.length }
}
const listen = (server) => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)))
function backend(label, seen) {
  const s = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method })
      const body = Buffer.concat(chunks).toString()
      res.setHeader('content-type', 'application/json')
      res.setHeader('set-cookie', 'fbeds_session=issued-by-' + label + '; Path=/; HttpOnly; Secure; SameSite=Lax')
      res.end(JSON.stringify({ backend: label, url: req.url, method: req.method, body, cookie: req.headers.cookie ?? null, host: req.headers.host }))
    })
  })
  return s
}
function get(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}
async function startPortal(app, port, env) {
  const dir = join(ROOT, 'apps', app, '.next/standalone/apps', app)
  const child = spawn('node', ['server.js'], { cwd: dir, env: { PATH: process.env.PATH, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ...APPS[app], ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`${app} exited: ${log.slice(-300)}`)
    try { await get(port, '/__ready'); return { child, log: () => log } } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  throw new Error(`${app} did not start: ${log.slice(-300)}`)
}
const stop = (p) => new Promise((r) => { p.child.once('exit', r); p.child.kill('SIGTERM'); setTimeout(() => p.child.kill('SIGKILL'), 3000) })
const freePort = async () => { const s = createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p }

for (const app of Object.keys(APPS)) {
  const artifact = join(ROOT, 'apps', app, '.next/standalone')
  if (!existsSync(join(artifact, 'apps', app, 'server.js'))) { check(`${app}: standalone build present`, false, 'build it first with NEXT_OUTPUT=standalone'); continue }
  const before = treeDigest(artifact)
  console.log(`\n== ${app}: artifact sha256 ${before.sha256} (${before.files} files)`)
  const seenA = [], seenB = []
  const A = backend('A', seenA), B = backend('B', seenB)
  const pa = await listen(A), pb = await listen(B)
  const [portA, portB, portBad] = [await freePort(), await freePort(), await freePort()]
  const runA = await startPortal(app, portA, { API_INTERNAL_URL: `http://127.0.0.1:${pa}/api/v1` })
  const runB = await startPortal(app, portB, { API_INTERNAL_URL: `http://127.0.0.1:${pb}/api/v1/` })
  try {
    const a = JSON.parse((await get(portA, '/api/v1/ping?x=1')).text), b = JSON.parse((await get(portB, '/api/v1/ping?x=1')).text)
    check(`${app}: configuration A reaches backend A`, a.backend === 'A' && a.url === '/api/v1/ping?x=1', JSON.stringify(a))
    check(`${app}: configuration B reaches backend B (same artifact, no rebuild)`, b.backend === 'B' && b.url === '/api/v1/ping?x=1', JSON.stringify(b))
    const post = await get(portA, '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'fbeds_session=abc', origin: 'http://127.0.0.1' }, body: '{"u":"x"}' })
    const pj = JSON.parse(post.text)
    check(`${app}: POST body and request cookie are forwarded`, pj.method === 'POST' && pj.body === '{"u":"x"}' && pj.cookie === 'fbeds_session=abc', post.text)
    const sc = [post.headers['set-cookie']].flat().join(';')
    check(`${app}: Set-Cookie passes through host-only (no Domain), Secure, HttpOnly`, /fbeds_session=issued-by-A/.test(sc) && !/domain=/i.test(sc) && /secure/i.test(sc) && /httponly/i.test(sc), sc)
    const dotted = JSON.parse((await get(portA, '/api/v1/exports/report.csv')).text)
    check(`${app}: dotted API paths (exports) are proxied`, dotted.backend === 'A' && dotted.url === '/api/v1/exports/report.csv', JSON.stringify(dotted))
    const n = seenA.length
    const esc = await Promise.all(['/api/v1/%2e%2e/docs', '/api/v1/%2E%2E/docs', '/api/v1/../docs'].map((p) => get(portA, p)))
    check(`${app}: path escape attempts are rejected by the portal (404) and never reach the backend`, esc.every((e) => e.status === 404) && seenA.length === n && seenA.slice(n).every((s) => s.url.startsWith('/api/v1/')) && !seenA.slice(n).some((s) => /docs/.test(s.url)), JSON.stringify([esc.map((e) => e.status), seenA.slice(n)]))
    const hosted = await startPortal(app, portBad, { API_INTERNAL_URL: `http://127.0.0.1:${pa}/api/v1`, PORTAL_HOSTED: '1' })
    try {
      const hitsBefore = seenA.length
      const bad = await get(portBad, '/api/v1/ping')
      check(`${app}: hosted + non-HTTPS/loopback origin fails closed with 503 and a fixed code`, bad.status === 503 && JSON.parse(bad.text).error === 'portal_api_origin_misconfigured' && !bad.text.includes('127.0.0.1') && bad.headers['cache-control'] === 'no-store', bad.status + bad.text)
      check(`${app}: the misconfigured proxy never called the backend`, seenA.length === hitsBefore, `backend saw ${seenA.length - hitsBefore} request(s)`)
    } finally { await stop(hosted) }
    if (app === 'admin') {
      const root = await get(portA, '/')
      check('admin: anonymous request is still redirected to /login (auth gate intact)', [302, 303, 307, 308].includes(root.status) && /\/login/.test(String(root.headers.location)), `${root.status} ${root.headers.location}`)
      const login = await get(portA, '/login')
      check('admin: /login renders (SSR) with a runtime-only configuration', login.status === 200, String(login.status))
    }
  } finally { await Promise.all([stop(runA), stop(runB)]); A.close(); B.close() }
  const after = treeDigest(artifact)
  check(`${app}: artifact digest unchanged after running in both configurations`, before.sha256 === after.sha256, `${before.sha256} vs ${after.sha256}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
