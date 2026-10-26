// Guard for committed `.env.example` files (SEC-01): they document variables, they never carry values. Every assignment must be empty, a
// placeholder (CHANGE_ME, <...>, your-...), a number/boolean/plain word, or a URL that points at localhost / *.example. A URL with an embedded
// password, or a long high-entropy value, fails. Gitleaks (.gitleaks.toml) still scans history; this catches it before commit and in check:architecture.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLACEHOLDER = /change[-_]?me|placeholder|your[-_]|example|replace|dummy|<[^>]+>|…/i
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[?::1\]?|host\.docker\.internal|[a-z0-9.-]+\.example(?:\.(?:com|org|net))?)$/i

export function check(name, text) {
  const problems = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^\s*#\s?(?=[A-Z][A-Z0-9_]*=)/, '').trim() // commented-out assignments are scanned too
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!m) return
    const [, key, rest] = m
    const value = rest.replace(/^["']|["']$/g, '').trim()
    const where = `${name}:${i + 1} ${key}`
    if (!value || PLACEHOLDER.test(value)) return
    const url = /^[a-z][a-z0-9+.-]*:\/\/(?:([^\s:@/]+):([^\s@/]+)@)?([^\s:/?#]+)/i.exec(value)
    if (url) {
      if (url[2]) problems.push(`${where}: URL embeds a password; use a placeholder or a secret reference`)
      else if (!LOCAL_HOST.test(url[3])) problems.push(`${where}: URL points at non-local host ${url[3]}; use localhost or an .example domain`)
      return
    }
    if (/^[A-Za-z0-9/+=_-]{24,}$/.test(value)) problems.push(`${where}: looks like a real token or key (${value.length} chars)`)
    else if (/(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)$/.test(key) && !/^\d+$/.test(value)) problems.push(`${where}: secret-named variable has a non-placeholder value`)
  })
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '*.env.example', '**/.env.example', '.env.example'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const unique = [...new Set(files)]
  const problems = unique.flatMap((f) => check(f, readFileSync(f, 'utf8')))
  if (problems.length) { console.error(`Env example check failed:\n- ${problems.join('\n- ')}`); process.exit(1) }
  console.log(`Env example check: ${unique.length} .env.example files contain only empty, placeholder or local values.`)
}
