import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { FIXTURE, deliverAlarms, loadAlarmSources, sliAlarmsFromTerraform, unpublishedAlarms } from './alarm-delivery.mjs'

const { alarms, unpublished } = loadAlarmSources()

test('every CloudWatch alarm publishes to the shared topic', () => {
  assert.deepEqual(unpublished, [])
})

test('SLI thresholds match the staging objectives', () => {
  const byMetric = Object.fromEntries(alarms.map((alarm) => [alarm.metric, alarm.threshold]))
  assert.deepEqual(byMetric, {
    AuthenticationServerError: 5,
    SearchServerError: 5,
    RecheckServerError: 5,
    BookingServerError: 1,
    CancellationServerError: 1,
    AuthorizationDenial: 100,
  })
})

test('a subscriber receives the booking and cancellation pages and nothing below threshold', () => {
  const result = deliverAlarms({ records: FIXTURE, subscriber: 'oncall@example.com', alarms })
  assert.equal(result.monitored, true)
  assert.deepEqual(result.delivered.map((page) => page.metric).sort(), ['BookingServerError', 'CancellationServerError'])
  assert.ok(result.delivered.every((page) => page.value === 1 && page.endpoint === 'oncall@example.com'))
})

test('an empty subscriber is not monitoring and delivers nothing', () => {
  for (const subscriber of ['', '   ', 'oncall', 'ops@localhost']) {
    const result = deliverAlarms({ records: FIXTURE, subscriber, alarms })
    assert.equal(result.monitored, false, subscriber)
    assert.deepEqual(result.delivered, [])
  }
})

test('authentication failures do not count toward the authorization alarm', () => {
  const records = Array.from({ length: 100 }, () => ({ event: 'ops.sli', signal: 'authentication', outcome: 'denied', status: 401 }))
  const result = deliverAlarms({ records, subscriber: 'oncall@example.com', alarms })
  assert.deepEqual(result.delivered, [])
})

test('search pages once the fifth server error arrives', () => {
  const records = Array.from({ length: 5 }, () => ({ event: 'ops.sli', signal: 'search', outcome: 'server_error', status: 500 }))
  const result = deliverAlarms({ records, subscriber: 'oncall@example.com', alarms })
  assert.deepEqual(result.delivered.map((page) => page.metric), ['SearchServerError'])
})

test('an alarm without a topic action is named', () => {
  const text = 'resource "aws_cloudwatch_metric_alarm" "silent" {\n  alarm_name = "x"\n}\n'
  assert.deepEqual(unpublishedAlarms(text), ['silent'])
})

test('the drill command fails closed without a subscriber and passes with one', () => {
  const missing = spawnSync(process.execPath, ['tools/ops/alarm-delivery.mjs'], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.match(missing.stdout, /"monitored":false/)
  const present = spawnSync(process.execPath, ['tools/ops/alarm-delivery.mjs', '--subscriber', 'oncall@example.com'], { encoding: 'utf8' })
  assert.equal(present.status, 0, present.stderr)
  assert.match(present.stdout, /"delivered":\["BookingServerError","CancellationServerError"\]/)
})

test('parser reads the booking threshold from the Terraform map', () => {
  const parsed = sliAlarmsFromTerraform(`
locals {
  sli_server_errors = {
    booking = { signal = "booking", metric = "BookingServerError", threshold = 1, description = "x" }
  }
}
resource "aws_cloudwatch_metric_alarm" "sli_authorization_denial" {
  metric_name = "AuthorizationDenial"
  threshold   = 100
}
`)
  assert.equal(parsed.find((alarm) => alarm.metric === 'BookingServerError').threshold, 1)
  assert.equal(parsed.find((alarm) => alarm.metric === 'AuthorizationDenial').threshold, 100)
})
