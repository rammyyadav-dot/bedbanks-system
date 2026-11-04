// next typegen adds `.next/dev/types` so dev and build can share one tsconfig.
// The certified check must not typecheck whatever a previous `next dev` left there.
import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../tsconfig.json', import.meta.url)
const config = JSON.parse(readFileSync(path, 'utf8'))
config.include = config.include.filter((entry) => !entry.includes('.next/dev/types'))
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
