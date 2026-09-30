// Cross-platform `pnpm dev`: runs the API (port 3002) alongside the Agent app (port 3000).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERCEL_ENV_FILE = '/vercel/share/.env.project'
const root = fileURLToPath(new URL('..', import.meta.url))

if (existsSync(VERCEL_ENV_FILE)) process.loadEnvFile(VERCEL_ENV_FILE)

const pnpmExecPath = process.env.npm_execpath

function runPnpm(dir, env) {
  const options = { cwd: join(root, dir), env: { ...process.env, ...env }, stdio: 'inherit' }
  return pnpmExecPath
    ? spawn(process.execPath, [pnpmExecPath, 'dev'], options)
    : spawn('pnpm', ['dev'], { ...options, shell: true })
}

function stop(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

const api = runPnpm('apps/api', { API_PORT: '3002', ADMIN_ORIGIN: 'http://localhost:3000' })
const agent = runPnpm('apps/agent', { NEXT_PUBLIC_AGENT_API_URL: 'http://localhost:3002/api/v1' })

agent.on('exit', (code) => {
  stop(api)
  process.exit(code ?? 1)
})
api.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error(`API exited with code ${code}; the Agent app keeps running.`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(api)
    stop(agent)
  })
}
