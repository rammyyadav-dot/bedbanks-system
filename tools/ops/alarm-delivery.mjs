// Local alarm-delivery drill (docs/runbooks/recovery.md). No AWS and no SNS.
// A page is delivered only when every CloudWatch alarm publishes to the alarm topic and a subscriber address is set.
// The fixture is one booking server error and one cancellation server error, below every other threshold.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TF = 'infra/aws/terraform'

export const FIXTURE = [
  { event: 'ops.sli', signal: 'booking', outcome: 'server_error', status: 500 },
  { event: 'ops.sli', signal: 'cancellation', outcome: 'server_error', status: 500 },
  { event: 'ops.sli', signal: 'booking', outcome: 'client_error', status: 400 },
  { event: 'ops.sli', signal: 'authentication', outcome: 'denied', status: 401 },
  ...Array.from({ length: 4 }, () => ({ event: 'ops.sli', signal: 'search', outcome: 'server_error', status: 500 })),
]

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function sliAlarmsFromTerraform(text) {
  const map = /sli_server_errors = \{([\s\S]*?)\n  \}/.exec(text)
  if (!map) throw new Error('sli.tf is missing sli_server_errors')
  const alarms = []
  for (const match of map[1].matchAll(/(\w+)\s*=\s*\{[^}]*signal\s*=\s*"([^"]+)"[^}]*metric\s*=\s*"([^"]+)"[^}]*threshold\s*=\s*(\d+)/g)) {
    alarms.push({ id: match[1], signal: match[2], metric: match[3], threshold: Number(match[4]), outcome: 'server_error' })
  }
  const denial = /metric_name\s*=\s*"AuthorizationDenial"[\s\S]{0,400}?threshold\s*=\s*(\d+)/.exec(text)
  if (!denial) throw new Error('sli.tf is missing the AuthorizationDenial threshold')
  alarms.push({ id: 'authorization', metric: 'AuthorizationDenial', threshold: Number(denial[1]), outcome: 'denied', excludeSignal: 'authentication' })
  return alarms
}

function braceBlock(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

/** Alarm resource names that do not publish to the shared alarm topic. */
export function unpublishedAlarms(text) {
  const missing = []
  const re = /resource\s+"aws_cloudwatch_metric_alarm"\s+"([^"]+)"\s*\{/g
  for (const match of text.matchAll(re)) {
    const body = braceBlock(text, match.index + match[0].length - 1)
    if (!/alarm_actions\s*=\s*\[aws_sns_topic\.alarms\.arn\]/.test(body)) missing.push(match[1])
  }
  return missing
}

export function loadAlarmSources(root = process.cwd()) {
  const dir = join(root, TF)
  const files = readdirSync(dir).filter((name) => name.endsWith('.tf')).sort()
  const text = files.map((name) => readFileSync(join(dir, name), 'utf8').replace(/^\s*#.*$/gm, '')).join('\n')
  return { alarms: sliAlarmsFromTerraform(readFileSync(join(dir, 'sli.tf'), 'utf8')), unpublished: unpublishedAlarms(text) }
}

function matches(alarm, record) {
  if (record.event !== 'ops.sli' || record.outcome !== alarm.outcome) return false
  if (alarm.excludeSignal && record.signal === alarm.excludeSignal) return false
  if (alarm.signal && record.signal !== alarm.signal) return false
  return true
}

/**
 * Deliver a page for each alarm whose fixture count meets its threshold.
 * An empty or non-address subscriber is unmonitored: nothing is delivered.
 */
export function deliverAlarms({ records, subscriber, alarms }) {
  const endpoint = typeof subscriber === 'string' ? subscriber.trim() : ''
  if (!EMAIL.test(endpoint)) return { monitored: false, delivered: [] }
  const delivered = []
  for (const alarm of alarms) {
    const value = records.filter((record) => matches(alarm, record)).length
    if (value >= alarm.threshold) delivered.push({ metric: alarm.metric, value, endpoint })
  }
  return { monitored: true, delivered }
}

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function main() {
  const subscriber = arg('--subscriber') ?? ''
  const { alarms, unpublished } = loadAlarmSources()
  if (unpublished.length) {
    console.error(`alarms with no subscriber action: ${unpublished.join(', ')}`)
    process.exit(1)
  }
  const result = deliverAlarms({ records: FIXTURE, subscriber, alarms })
  const metrics = result.delivered.map((page) => page.metric).sort()
  console.log(JSON.stringify({ drill: 'alarm-delivery', monitored: result.monitored, delivered: metrics }))
  if (!result.monitored) process.exit(2)
  const expected = ['BookingServerError', 'CancellationServerError']
  if (metrics.length !== expected.length || expected.some((metric) => !metrics.includes(metric))) process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
