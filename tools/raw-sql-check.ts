import { readFileSync, writeFileSync, globSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, relative } from 'node:path'
import type * as TS from 'typescript'

const ts = createRequire(resolve(process.cwd(), 'apps/api/package.json'))('typescript') as typeof TS

/**
 * Raw-SQL injection gate (CLAUDE.md invariant 7; companion to the tenant-filter check, which covers tenant predicates).
 *
 * Production code under apps/ and packages/ (tests, specs and e2e are excluded) may run raw SQL only in these forms:
 *  - tagged template   $queryRaw`... ${value} ...` / $executeRaw`...`        values become bind parameters
 *  - Prisma.sql`...`   passed to $queryRaw($executeRaw)(Prisma.sql`...`)    values become bind parameters
 *
 * Findings:
 *  - unsafe-call     $queryRawUnsafe / $executeRawUnsafe / Prisma.raw: the string is sent to PostgreSQL as written
 *  - dynamic-raw     $queryRaw(...) / $executeRaw(...) called with anything but Prisma.sql`...` (a string, a template literal, a variable)
 *  - interpolated    Unsafe call whose argument interpolates a value (template literal with ${} or string concatenation) and has no audit marker
 *
 * Unsafe calls are needed for DDL and role administration (CREATE ROLE, GRANT, SET ROLE take identifiers, which cannot be bound). They are
 * audited, not banned:
 *  - `// raw-sql: <reason>` on the same or preceding line exempts one site (a reason is mandatory; ESLint needs
 *    `// eslint-disable-next-line no-restricted-syntax -- raw-sql: <reason>`, which this check accepts too), or
 *  - security/raw-sql-baseline.json records how many unsafe sites each pre-existing file has. A file may never exceed its recorded count, and a
 *    file that is not listed has zero. Lower the number when sites are removed (the check fails on a stale, too-high baseline so it only ratchets down).
 * Interpolated values inside an audited site must be identifiers/constants from the codebase, never request, supplier or tenant input.
 * `--report` prints every finding; `--write-baseline` rewrites the baseline from the current tree (review the diff before committing it).
 */
const root = process.cwd()
const baselinePath = resolve(root, 'security/raw-sql-baseline.json')
const UNSAFE = new Set(['$queryRawUnsafe', '$executeRawUnsafe'])
const SAFE_TAGGED = new Set(['$queryRaw', '$executeRaw'])
const isTest = (f: string) => /(\.spec\.|\.test\.|\.e2e-spec\.|\/test\/|\/tests\/|\/e2e\/)/.test(f)

type Finding = { file: string; line: number; rule: string; detail: string }

export function scan(file: string, text: string): { findings: Finding[]; unsafeSites: number } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lines = text.split('\n')
  const findings: Finding[] = []
  let unsafeSites = 0
  const lineOf = (n: TS.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const audited = (line: number) => [lines[line - 1], lines[line - 2]].some((l) => /(?:\/\/|--)\s*raw-sql:\s*\S+/.test(l ?? ''))
  const isPrismaSqlTag = (n: TS.Node) => ts.isTaggedTemplateExpression(n) && /^(Prisma\.)?sql$/.test(n.tag.getText(sf))
  const interpolates = (n: TS.Node): boolean =>
    (ts.isTemplateExpression(n) && n.templateSpans.length > 0) ||
    (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && !(ts.isStringLiteralLike(n.left) && ts.isStringLiteralLike(n.right))) ||
    ts.isIdentifier(n) || ts.isCallExpression(n)
  const calleeName = (e: TS.Expression) => (ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : '')

  const visit = (node: TS.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      const full = node.expression.getText(sf)
      const line = lineOf(node)
      const arg = node.arguments[0]
      if (UNSAFE.has(name) || full === 'Prisma.raw') {
        unsafeSites += 1
        if (!audited(line)) {
          const dyn = arg ? interpolates(arg) : false
          findings.push({ file, line, rule: dyn ? 'interpolated' : 'unsafe-call', detail: `${full}(${dyn ? 'interpolated/dynamic SQL' : 'static SQL'}): use ${'$queryRaw`..${value}..`'} / Prisma.sql so values are bound, or add "// raw-sql: <reason>" for DDL/identifiers` })
        }
      } else if (SAFE_TAGGED.has(name) && arg && !audited(line)) {
        // The TypeScript signature only accepts Prisma.Sql, so identifiers, calls and conditionals of Sql values are typed. A string literal, template
        // literal or concatenation here is SQL text built by hand (the classic injection shape, and a runtime error in Prisma >= 5 only on some paths).
        const text = ts.isParenthesizedExpression(arg) ? arg.expression : arg
        if (ts.isStringLiteralLike(text) || ts.isTemplateExpression(text) || ts.isBinaryExpression(text)) {
          findings.push({ file, line, rule: 'dynamic-raw', detail: `${full}() argument must be Prisma.sql\`...\`, not hand-built SQL text (${ts.SyntaxKind[text.kind]})` })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { findings, unsafeSites }
}

export function evaluate(perFile: Record<string, { findings: Finding[]; unsafeSites: number }>, baseline: Record<string, number>) {
  const problems: string[] = []
  for (const [file, { findings, unsafeSites }] of Object.entries(perFile)) {
    const allowed = baseline[file] ?? 0
    const hard = findings.filter((f) => f.rule === 'dynamic-raw')
    for (const f of hard) problems.push(`${f.file}:${f.line} [${f.rule}] ${f.detail}`)
    const unsafe = findings.filter((f) => f.rule !== 'dynamic-raw')
    if (unsafeSites > allowed && unsafe.length) {
      for (const f of unsafe) problems.push(`${f.file}:${f.line} [${f.rule}] ${f.detail} (file has ${unsafeSites} unsafe sites, baseline allows ${allowed})`)
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const have = perFile[file]?.unsafeSites ?? 0
    if (have < allowed) problems.push(`security/raw-sql-baseline.json: ${file} allows ${allowed} unsafe sites but has ${have}; lower the baseline (it only ratchets down)`)
  }
  return problems
}

if (process.argv[1] && /raw-sql-check\.ts$/.test(process.argv[1])) {
  const files = ['apps/*/src/**/*.{ts,tsx}', 'apps/*/scripts/**/*.{ts,mjs,cjs}', 'packages/*/src/**/*.ts']
    .flatMap((g) => globSync(g.replace(/\{[^}]*\}/, '*'), { cwd: root }))
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => !f.includes('node_modules') && !isTest(f) && /\.(ts|tsx)$/.test(f))
  const perFile: Record<string, { findings: Finding[]; unsafeSites: number }> = {}
  for (const f of [...new Set(files)].sort()) {
    const r = scan(f, readFileSync(resolve(root, f), 'utf8'))
    if (r.unsafeSites || r.findings.length) perFile[f] = r
  }
  if (process.argv.includes('--write-baseline')) {
    const next = Object.fromEntries(Object.entries(perFile).filter(([, v]) => v.unsafeSites).map(([k, v]) => [k, v.unsafeSites]))
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
    console.log(`Wrote ${Object.keys(next).length} files to ${relative(root, baselinePath)}`)
    process.exit(0)
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>
  const problems = evaluate(perFile, baseline)
  if (process.argv.includes('--report')) for (const v of Object.values(perFile)) for (const f of v.findings) console.log(`${f.file}:${f.line} [${f.rule}]`)
  if (problems.length) {
    console.error(`Raw SQL check failed (${problems.length}):\n- ${problems.join('\n- ')}\nSee the header of tools/raw-sql-check.ts for the allowed forms.`)
    process.exit(1)
  }
  console.log(`Raw SQL check: ${files.length} production files scanned; unsafe SQL confined to ${Object.keys(baseline).length} audited files, no dynamic $queryRaw/$executeRaw.`)
}
