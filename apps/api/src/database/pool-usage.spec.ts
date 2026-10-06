import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * ADR 0040: every long-lived Prisma client the API creates from its own URL must get its pool from `withPoolSettings` (explicit cap, wait limit,
 * pooler flag). A new dedicated client (a cancellation or settlement database, say) that skips it would silently fall back to Prisma's CPU-sized default
 * and not be counted in the Terraform connection budget. One-off owner CLIs (`*.cli.ts`) are excluded: they run once and exit.
 */
const SRC = join(__dirname, '..')
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  if (statSync(path).isDirectory()) return files(path)
  return /\.ts$/.test(name) && !/\.(spec|e2e-spec|cli)\.ts$/.test(name) ? [path] : []
})

describe('pool usage (ADR 0040)', () => {
  it('PU-01: every PrismaService built from an explicit URL passes it through withPoolSettings', () => {
    const offenders: string[] = []
    for (const file of files(SRC)) {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/new\s+(?:PrismaService|PrismaClient)\s*\(\s*\{[^}]*datasourceUrl\s*:\s*([^,}]+)/g)) {
        if (!/withPoolSettings\s*\(/.test(m[1]) && !/withPoolSettings\s*\(/.test(source.slice(m.index ?? 0, (m.index ?? 0) + 400))) offenders.push(`${relative(SRC, file)}: ${m[0].slice(0, 90)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('PU-02: the scanner sees a client that skips the pool settings (so PU-01 cannot pass by being blind)', () => {
    const bad = "const c = new PrismaService({ datasourceUrl: process.env.CANCELLATION_DATABASE_URL as string })"
    const hit = [...bad.matchAll(/new\s+(?:PrismaService|PrismaClient)\s*\(\s*\{[^}]*datasourceUrl\s*:\s*([^,}]+)/g)].filter((m) => !/withPoolSettings\s*\(/.test(m[1]))
    expect(hit).toHaveLength(1)
  })
})
