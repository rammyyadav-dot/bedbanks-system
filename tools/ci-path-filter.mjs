// Path filter for ci.yml. Prints GitHub Actions outputs. Fail-open: if the diff cannot be read, every job runs.
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const GROUPS = {
  prisma: [/^(apps\/api\/prisma\/|apps\/api\/src\/database\/)/],
  api: [/^apps\/api\//],
  website: [/^apps\/website\//],
  portals: [/^apps\/(agent|admin|supplier)\//],
  packages: [/^packages\//],
  tools: [/^tools\//],
  e2e: [/^e2e\//],
  workflow: [/^\.github\/workflows\/ci\.yml$/],
  lockfile: [/^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|turbo\.json|eslint\.config\.mjs)$/],
}

export function classify(files) {
  const hit = (name) => files.some((file) => GROUPS[name].some((re) => re.test(file)))
  const workflow = hit('workflow')
  const force = workflow || files.length === 0
  return {
    prisma: force || hit('prisma') || hit('api'),
    verify: force || hit('api') || hit('website') || hit('portals') || hit('packages') || hit('tools') || hit('lockfile') || hit('e2e'),
    e2e: force || hit('api') || hit('portals') || hit('packages') || hit('e2e'),
    website: force || hit('website') || hit('packages') || hit('lockfile'),
  }
}

export function resolveRange(env = process.env) {
  if (env.EVENT === 'pull_request' && env.BASE_REF) return `origin/${env.BASE_REF}...HEAD`
  if (env.BEFORE && env.BEFORE !== '0000000000000000000000000000000000000000') return `${env.BEFORE}...HEAD`
  return 'origin/main...HEAD'
}

function changedFiles(range) {
  return execSync(`git diff --name-only ${range}`, { encoding: 'utf8' }).split('\n').map((line) => line.trim()).filter(Boolean)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let files
  try {
    const range = resolveRange()
    files = changedFiles(range)
  } catch {
    files = []
  }
  const flags = classify(files)
  for (const [key, value] of Object.entries(flags)) console.log(`${key}=${value}`)
}
