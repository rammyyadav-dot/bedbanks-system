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

test('proxies /api/v1 to API_INTERNAL_URL without a trailing slash', async () => {
  const config = await load({ API_INTERNAL_URL: 'https://api.example/api/v1/' })
  assert.deepEqual(await config.rewrites(), [{ source: '/api/v1/:path*', destination: 'https://api.example/api/v1/:path*' }])
})

test('falls back to the local API outside Vercel', async () => {
  const config = await load({})
  assert.equal((await config.rewrites())[0].destination, 'http://localhost:3002/api/v1/:path*')
})

test('fails a Vercel build that has no API_INTERNAL_URL', async () => {
  await assert.rejects(load({ VERCEL: '1' }), /API_INTERNAL_URL is required/)
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
