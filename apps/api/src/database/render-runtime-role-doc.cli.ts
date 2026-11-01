import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderRuntimeRoleMatrix } from './runtime-role-contract'

/** Rewrites the generated privilege matrix in docs/strict-runtime-db-role.md from runtime-role-contract.ts. Offline; touches no database. */
const file = join(__dirname, '..', '..', '..', '..', 'docs', 'strict-runtime-db-role.md')
const begin = '<!-- BEGIN GENERATED: runtime-role-matrix -->'
const end = '<!-- END GENERATED: runtime-role-matrix -->'
const text = readFileSync(file, 'utf8')
const from = text.indexOf(begin)
const to = text.indexOf(end)
if (from < 0 || to < 0) throw new Error('generated block markers not found')
writeFileSync(file, `${text.slice(0, from + begin.length)}\n${renderRuntimeRoleMatrix()}\n${text.slice(to)}`)
console.log('matrix rewritten')
