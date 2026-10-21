import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [] })

/** Application paths that may write DailyRate without the feed-managed guard, each with its reason. Anything else that writes a nightly price must call it (ADR 0082). */
const EXEMPT: Record<string, string> = {
  'database/provision-preview-fixtures.cli.ts': 'operator CLI that seeds disposable preview data; never runs in a deployment',
}

describe('single writer for feed-managed plans (ADR 0082)', () => {
  it('every application path that writes DailyRate refuses a feed-managed plan, or is listed as exempt', () => {
    const writers = files(root).filter((f) => !/\.(spec|test)\.ts$/.test(f) && /\bdailyRate\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|(INSERT INTO|UPDATE|DELETE FROM)\s+"DailyRate"/.test(readFileSync(f, 'utf8')) && !/-verify\.ts$|-role\.ts$/.test(f))
    const rel = writers.map((f) => f.slice(root.length + 1))
    const unguarded = rel.filter((f) => !(f in EXEMPT) && !/assertRatesNotFeedManaged/.test(readFileSync(join(root, f), 'utf8')))
    expect({ unguarded }).toEqual({ unguarded: [] })
    expect(rel).toEqual(expect.arrayContaining(['supply/supply.service.ts', 'hotel-setup/hotel-quick-update.service.ts']))
  })
})
