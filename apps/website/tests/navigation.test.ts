import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { findBrokenInternalLinks } from '../scripts/link-integrity'
import { resolveWebsiteConfig } from '../lib/config-utils'
test('navigation has no invalid internal paths', () => { const root = resolve(import.meta.dirname, '..'); assert.deepEqual(findBrokenInternalLinks(resolve(root, 'app'), root), []) })
test('external portals use configured deployment URLs', () => { const config = resolveWebsiteConfig({ NODE_ENV: 'production', NEXT_PUBLIC_AGENT_URL: 'https://agent.example', NEXT_PUBLIC_SUPPLIER_URL: 'https://supplier.example', NEXT_PUBLIC_ADMIN_URL: 'https://admin.example' }); assert.deepEqual(config.portals, { agent: 'https://agent.example', supplier: 'https://supplier.example', admin: 'https://admin.example' }) })
