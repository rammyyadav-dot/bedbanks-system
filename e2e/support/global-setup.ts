import { existsSync } from 'node:fs'
import { STATE_FILE, startStack } from './stack'

/** Starts the disposable stack. `E2E_REUSE_STACK=1` keeps one started by `pnpm e2e:up` (fast local iteration). */
export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_REUSE_STACK === '1' && existsSync(STATE_FILE)) return
  await startStack()
}
