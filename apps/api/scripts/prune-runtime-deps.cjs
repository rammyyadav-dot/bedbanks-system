#!/usr/bin/env node
// Container build step (ADR 0075): removes every package from a `pnpm deploy --prod` directory that the API's production dependencies cannot reach.
//
//   node scripts/prune-runtime-deps.cjs /prod/api                  # keep what the package's production dependencies reach
//   node scripts/prune-runtime-deps.cjs /prod/migrate --only prisma  # keep only what the named packages reach (the migrator image)
//
// pnpm installs the workspace root's own `dependencies` (next, react, react-dom: the portal apps' runtime) into every deployed project, and auto-installs
// optional peers such as the prisma CLI and typescript beside @prisma/client. None of these is reachable from apps/api, so the runtime image would carry
// several hundred megabytes it never loads. Reachability follows `dependencies`, `optionalDependencies` and non-optional `peerDependencies`, resolved the
// way Node resolves them (nearest ancestor node_modules, which includes pnpm's hidden hoist directory), so a package that leans on an undeclared hoisted
// dependency still finds it. The generated Prisma client (.prisma) lives inside the @prisma/client store entry and is kept with it.
const { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const [dirArg, flag, onlyArg] = process.argv.slice(2)
const root = resolve(dirArg ?? '')
const only = flag === '--only' && onlyArg ? onlyArg.split(',') : null
if (!dirArg || (flag && !only) || !existsSync(join(root, 'package.json'))) { console.error('usage: prune-runtime-deps.cjs <pnpm deploy directory> [--only <package>[,<package>...]]'); process.exit(2) }
const store = join(root, 'node_modules', '.pnpm')
if (!existsSync(store)) { console.error(`${store} not found: expected a pnpm deploy directory.`); process.exit(2) }

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
function dependencyNames(pkg) {
  const optionalPeers = pkg.peerDependenciesMeta ?? {}
  const peers = Object.keys(pkg.peerDependencies ?? {}).filter((name) => !optionalPeers[name]?.optional)
  return { required: [...Object.keys(pkg.dependencies ?? {}), ...peers], optional: Object.keys(pkg.optionalDependencies ?? {}) }
}
function locate(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dir === root || dir === dirname(dir)) return null
  }
}

const kept = new Set()
const missing = []
const queue = [root]
while (queue.length) {
  const dir = queue.pop()
  const { required, optional } = dir === root && only ? { required: only, optional: [] } : dependencyNames(readJson(join(dir, 'package.json')))
  for (const name of [...required, ...optional]) {
    const found = locate(dir, name)
    if (!found) { if (required.includes(name) && dir === root) missing.push(name); continue }
    if (!kept.has(found)) { kept.add(found); queue.push(found) }
  }
}
// A direct dependency the deploy did not install is a broken image, not something to prune around.
if (missing.length) { console.error(`Direct dependencies not installed: ${missing.join(', ')}`); process.exit(1) }

const keptEntries = new Set([...kept].filter((p) => p.startsWith(store + '/')).map((p) => p.slice(store.length + 1).split('/')[0]))
const entries = readdirSync(store).filter((entry) => entry !== 'node_modules' && !entry.startsWith('.') && statSync(join(store, entry)).isDirectory())
const removed = entries.filter((entry) => !keptEntries.has(entry))
for (const entry of removed) rmSync(join(store, entry), { recursive: true, force: true })

// Links into removed entries (top-level node_modules, scopes, the hoist directory) now dangle; bins are never run in the container.
function dropDangling(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (lstatSync(path).isSymbolicLink()) { if (!existsSync(path)) rmSync(path, { force: true }) }
    else if (name.startsWith('@') && lstatSync(path).isDirectory()) dropDangling(path)
  }
}
dropDangling(join(root, 'node_modules'))
dropDangling(join(store, 'node_modules'))
rmSync(join(root, 'node_modules', '.bin'), { recursive: true, force: true })

console.log(`Runtime dependencies: kept ${keptEntries.size} of ${entries.length} store entries; removed ${removed.length} unreachable.`)
