import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('marketing sign-in opens the agent workspace', () => {
  const home = readFileSync(new URL('../components/marketing-home.tsx', import.meta.url), 'utf8')
  const login = readFileSync(new URL('./login/page.tsx', import.meta.url), 'utf8')
  assert.match(home, /href="\/login"/)
  assert.match(login, /AgentAuthGate/)
})
