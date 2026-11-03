import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkRepository,
  committableRuntimeEnvProblems,
  credentialFindings,
  dockerignoreProblems,
  gitignoreProblems,
  trackedRuntimeEnvProblems,
} from './runtime-env-leak-check.mjs'

const GITIGNORE = '.env\n.env.*\n!.env.example\n'
const DOCKERIGNORE = '.env\n**/.env\n**/.env.*\n'

test('ignore policy keeps runtime env files out of git and image builds', () => {
  assert.deepEqual(gitignoreProblems(GITIGNORE), [])
  assert.deepEqual(dockerignoreProblems(DOCKERIGNORE), [])
  assert.equal(gitignoreProblems('.env\n.env.local\n').length, 2)
  assert.equal(gitignoreProblems('.env\n!.env.example\n.env.*\n').length, 1)
  assert.equal(dockerignoreProblems(`${DOCKERIGNORE}!**/.env.example\n`).length, 1)
  assert.equal(dockerignoreProblems('.env\n**/.env\n').length, 1)
})

test('only .env.example may be tracked', () => {
  assert.deepEqual(trackedRuntimeEnvProblems(['apps/api/.env.example', 'README.md']), [])
  assert.deepEqual(trackedRuntimeEnvProblems(['apps/api/.env', 'apps/admin/.env.production']), [
    'apps/api/.env is tracked; runtime env files stay untracked and .env.example is the only template',
    'apps/admin/.env.production is tracked; runtime env files stay untracked and .env.example is the only template',
  ])
  assert.equal(committableRuntimeEnvProblems(['apps/api/.env.development']).length, 1)
})

test('flags Neon, AWS and remote database credentials without echoing them', () => {
  const neonKey = `napi_${'abcdefghij'.repeat(4)}`
  const accessKey = ['AKIA', 'IOSFODNN7EXAMP', 'LE'].join('')
  const secretKey = ['wJalrXUt', 'nFEMI/K7', 'MDENG/bP', 'xRfiCYzQ', 'vZ8mN2pA'].join('')
  assert.match(neonKey, /^napi_[a-z0-9]{40}$/)
  assert.equal(accessKey.length, 20)
  assert.equal(secretKey.length, 40)
  const neon = credentialFindings('apps/api/.env', `NEON_API_KEY=${neonKey}\n`)
  assert.equal(neon.length, 1)
  assert.match(neon[0], /Neon API key/)
  assert.equal(neon[0].includes(neonKey), false)
  const aws = credentialFindings('a.env', `AWS_ACCESS_KEY_ID=${accessKey}\naws_secret_access_key=${secretKey}\n`)
  assert.equal(aws.length, 2)
  assert.equal(aws.some((line) => line.includes(accessKey) || line.includes(secretKey)), false)
  assert.equal(credentialFindings('a.env', 'DATABASE_URL=postgresql://fbeds_api_login:pw@localhost:5432/fbeds_dev\n').length, 0)
  const remote = credentialFindings('a.env', 'DATABASE_URL=postgresql://user:pw@ep-cool.us-east-2.aws.neon.tech/neondb\n')
  assert.equal(remote.length, 1)
  assert.match(remote[0], /ep-cool\.us-east-2\.aws\.neon\.tech/)
  assert.equal(remote[0].includes('user:pw'), false)
})

test('this workspace passes', () => {
  assert.deepEqual(checkRepository(), [])
})
