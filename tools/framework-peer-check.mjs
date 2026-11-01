// Framework peer guard (audit B2): every resolved @nestjs/* package in pnpm-lock.yaml must accept the resolved @nestjs/common and
// @nestjs/core as peers. A mismatch (e.g. @nestjs/swagger 12, which needs Nest 12 and is ESM-only, beside Nest 11) installs with
// only a warning, then fails Jest with "Cannot use import statement outside a module". Major framework moves go through an ADR.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FRAMEWORK_PEERS = ['@nestjs/common', '@nestjs/core']

const parse = (v) => v.replace(/^[=v]+/, '').split(/[-+]/)[0].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : null))
const cmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d } return 0 }

function comparator(token, version) {
  if (token === '*' || token === 'x' || token === '') return true
  const [, op = '', raw] = token.match(/^(\^|~|>=|<=|>|<|=)?(.+)$/)
  const want = parse(raw)
  if (want[0] === null) return true
  const c = cmp(version, want)
  if (op === '>=') return c >= 0
  if (op === '>') return c > 0
  if (op === '<=') return c <= 0
  if (op === '<') return c < 0
  // Partial versions (11, 11.x) and ^/~ share an upper bound: bump the first significant or wildcarded position.
  const fixed = want.findIndex((p) => p === null)
  const len = fixed === -1 ? 3 : fixed
  if (c < 0) return false
  let pos
  if (op === '^') pos = want[0] !== 0 || len === 1 ? 0 : want[1] !== 0 || len === 2 ? 1 : 2
  else if (op === '~') pos = len === 1 ? 0 : 1
  else if (len === 3) return c === 0
  else pos = len - 1
  const upper = want.slice(0, pos + 1).map((p) => p ?? 0)
  upper[pos] += 1
  return cmp(version, upper) < 0
}

export function satisfies(version, range) {
  const v = parse(version)
  return range.split('||').some((set) => set.trim().split(/\s+/).every((token) => comparator(token, v)))
}

// Reads the `packages:` section of a pnpm v9 lockfile into [{ name, version, peers: { dep: range } }].
export function readPackages(lockText) {
  const section = lockText.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
  const packages = []
  let current = null
  let inPeers = false
  for (const line of section.split('\n')) {
    const head = line.match(/^ {2}'?((?:@[^/]+\/)?[^@'\s]+)@([^'(:]+)'?:\s*$/)
    if (head) { current = { name: head[1], version: head[2], peers: {} }; packages.push(current); inPeers = false; continue }
    if (/^ {4}\S/.test(line)) { inPeers = /^ {4}peerDependencies:\s*$/.test(line); continue }
    const peer = inPeers && current && line.match(/^ {6}'?([^':]+)'?:\s*'?([^']+?)'?\s*$/)
    if (peer) current.peers[peer[1]] = peer[2]
  }
  return packages
}

export function check(lockText) {
  const packages = readPackages(lockText)
  const resolved = new Map(FRAMEWORK_PEERS.map((name) => [name, packages.filter((p) => p.name === name).map((p) => p.version)]))
  const problems = []
  for (const [name, versions] of resolved) if (versions.length > 1) problems.push(`${name} resolves to several versions (${versions.join(', ')}); the API must run one framework version`)
  for (const pkg of packages.filter((p) => p.name.startsWith('@nestjs/'))) {
    for (const peer of FRAMEWORK_PEERS) {
      const range = pkg.peers[peer]
      if (!range) continue
      for (const version of resolved.get(peer)) {
        if (!satisfies(version, range)) problems.push(`${pkg.name}@${pkg.version} needs ${peer} ${range} but ${version} is installed; pin it to a line that supports ${version} or plan the framework upgrade via an ADR`)
      }
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'))
  if (problems.length) { console.error(`Framework peer check failed:\n- ${problems.join('\n- ')}`); process.exit(1) }
  console.log('Framework peer check: every @nestjs/* package accepts the resolved @nestjs/common and @nestjs/core.')
}
