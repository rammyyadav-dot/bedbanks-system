// Runtime dotenv files (apps/*/.env and any .env.*) are local configuration. They must stay untracked, and they must not
// carry a Neon API key, an AWS credential, or a database URL whose host is not local. .env.example is the only template
// that may be committed, and it is not a Docker build input (ADR 0110). Gitleaks scans git history; this sees ignored files too.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[?::1\]?|host\.docker\.internal|[a-z0-9.-]+\.example(?:\.(?:com|org|net))?)$/i

export function isEnvExample(path) {
  return path.split('/').pop() === '.env.example'
}

export function isRuntimeEnv(path) {
  const base = path.split('/').pop()
  return base === '.env' || (base.startsWith('.env.') && base !== '.env.example')
}

export function gitignoreProblems(text) {
  const lines = text.split(/\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  const problems = []
  if (!lines.includes('.env')) problems.push('gitignore must ignore .env')
  const star = lines.lastIndexOf('.env.*')
  const allow = lines.lastIndexOf('!.env.example')
  if (star < 0) problems.push('gitignore must ignore .env.* so .env.local, .env.development and .env.production cannot be added')
  if (allow < 0 || allow < star) problems.push('gitignore must re-include .env.example after the .env.* rule')
  return problems
}

export function dockerignoreProblems(text) {
  const lines = text.split(/\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  const problems = []
  for (const required of ['.env', '**/.env', '**/.env.*']) {
    if (!lines.includes(required)) problems.push(`dockerignore must exclude ${required}`)
  }
  for (const line of lines) {
    if (line === '!.env.example' || line === '!**/.env.example') {
      problems.push('dockerignore must not re-include .env.example; templates are not image inputs')
    }
  }
  return problems
}

export function trackedRuntimeEnvProblems(paths) {
  return paths.filter(isRuntimeEnv).map((path) => `${path} is tracked; runtime env files stay untracked and .env.example is the only template`)
}

export function committableRuntimeEnvProblems(paths) {
  return paths.filter(isRuntimeEnv).map((path) => `${path} is untracked but not ignored, so a later git add would commit it`)
}

// Reports the file and rule only. Values are never included in the message.
export function credentialFindings(name, text) {
  const problems = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^\s*#\s?/, '')
    const where = `${name}:${index + 1}`
    if (/\bnapi_[a-z0-9]{20,}\b/.test(line)) problems.push(`${where} contains a Neon API key`)
    if (/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/.test(line)) problems.push(`${where} contains an AWS access key id`)
    if (/aws[_-]?secret[_-]?(?:access[_-]?)?key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/i.test(line)) {
      problems.push(`${where} contains an AWS secret access key`)
    }
    if (/aws[_-]?session[_-]?token\s*[:=]\s*['"]?[A-Za-z0-9/+=]{100,}/i.test(line)) {
      problems.push(`${where} contains an AWS session token`)
    }
    for (const match of line.matchAll(/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^\s'"`]*)/gi)) {
      const auth = /^[^/\s:@]+:[^@\s/]+@([^:/\s]+)/.exec(match[1])
      if (auth && !LOCAL_HOST.test(auth[1])) problems.push(`${where} database URL with a password points at ${auth[1]}`)
    }
  })
  return problems
}

function gitZ(args, root) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: root }).split('\0').filter(Boolean)
}

export function checkRepository(root = process.cwd()) {
  const problems = [
    ...gitignoreProblems(readFileSync(`${root}/.gitignore`, 'utf8')),
    ...dockerignoreProblems(readFileSync(`${root}/.dockerignore`, 'utf8')),
  ]
  const tracked = gitZ(['ls-files', '-z'], root)
  const committable = gitZ(['ls-files', '-z', '--others', '--exclude-standard'], root)
  problems.push(...trackedRuntimeEnvProblems(tracked), ...committableRuntimeEnvProblems(committable))
  const ignoredEnv = gitZ(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.env', '.env.*', '**/.env', '**/.env.*'], root)
  const toScan = [...new Set([...tracked.filter(isEnvExample), ...ignoredEnv.filter((path) => isRuntimeEnv(path) || isEnvExample(path)), ...committable.filter(isRuntimeEnv)])]
  for (const path of toScan) {
    problems.push(...credentialFindings(path, readFileSync(`${root}/${path}`, 'utf8')))
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkRepository()
  if (problems.length) {
    console.error(`Runtime env leak check failed:\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }
  console.log('Runtime env leak check: no tracked runtime env file, templates stay out of images, and no workspace dotenv file holds a Neon, AWS or remote database credential.')
}
