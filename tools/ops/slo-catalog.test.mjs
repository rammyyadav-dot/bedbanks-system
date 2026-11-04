import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const catalog = JSON.parse(readFileSync(new URL('../../docs/ops/slo-catalog.json', import.meta.url), 'utf8'))
const sli = readFileSync(new URL('../../infra/aws/terraform/sli.tf', import.meta.url), 'utf8')
const reindex = readFileSync(new URL('../../infra/aws/terraform/search-reindex.tf', import.meta.url), 'utf8')
const required = ['authentication', 'search', 'recheck', 'booking', 'cancellation', 'authorization', 'connector', 'job_backlog']

test('the catalog names every architecture signal and the alarmed metrics exist in Terraform', () => {
  assert.deepEqual(catalog.signals.map((signal) => signal.id), required)
  for (const signal of catalog.signals) {
    if (signal.id === 'connector') {
      assert.equal(signal.metric, null)
      continue
    }
    assert.match(signal.id === 'job_backlog' ? reindex : sli, new RegExp(signal.metric))
  }
  assert.match(sli, /aws_cloudwatch_dashboard" "operations"/)
  assert.match(sli, /ops\.sli/)
})
