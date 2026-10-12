import assert from 'node:assert/strict'
import test from 'node:test'

async function load(env) {
  const saved = { VERCEL: process.env.VERCEL, API_INTERNAL_URL: process.env.API_INTERNAL_URL }
  for (const key of Object.keys(saved)) delete process.env[key]
  Object.assign(process.env, env)
  try {
    return (await import(`../next.config.mjs?${Math.random()}`)).default
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('the API origin is no longer baked into the build: no next.config rewrites (proxy.ts resolves it per request, ADR 0055)', async () => {
  const config = await load({ API_INTERNAL_URL: 'https://api.example/api/v1/' })
  assert.equal(config.rewrites, undefined)
})

test('building does not need API_INTERNAL_URL, even on a hosted build (a misconfigured runtime fails closed with 503 instead)', async () => {
  await assert.doesNotReject(load({ VERCEL: '1' }))
})

test('browser calls default to the same-origin proxy', async () => {
  const saved = process.env.NEXT_PUBLIC_AGENT_API_URL
  delete process.env.NEXT_PUBLIC_AGENT_API_URL
  try {
    const { agentApiBase } = await import(`./api-config.mjs?${Math.random()}`)
    assert.equal(agentApiBase, '/api/v1')
  } finally {
    if (saved !== undefined) process.env.NEXT_PUBLIC_AGENT_API_URL = saved
  }
})
