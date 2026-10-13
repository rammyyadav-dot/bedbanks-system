import { stopStack } from './stack'

export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_REUSE_STACK === '1') return
  stopStack()
}
