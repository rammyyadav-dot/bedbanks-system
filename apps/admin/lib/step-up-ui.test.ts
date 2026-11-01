import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ApiResponseError } from './api/errors'
import { describeApiError } from './api/describe-error'

const err = (code: string, status: number) => new ApiResponseError(code, 'server text', status)

test('maker-checker failures get their own message, not the generic permission one', () => {
  assert.match(describeApiError(err('STEP_UP_FAILED', 403)), /password is not correct/)
  assert.match(describeApiError(err('STEP_UP_REQUIRED', 403)), /Enter your password/)
  assert.match(describeApiError(err('STEP_UP_THROTTLED', 429)), /Wait a few minutes/)
  assert.match(describeApiError(err('APPROVAL_EXPIRED', 409)), /expired/)
  assert.match(describeApiError(err('DUAL_APPROVAL_REQUIRED', 403)), /second person/)
})

test('a timeout says the decision may not have been applied', () => {
  assert.match(describeApiError(err('API_TIMEOUT', 504), 'approve'), /may not have been applied/)
})

test('other 403s keep the permission message', () => {
  assert.match(describeApiError(err('FORBIDDEN', 403), 'approve'), /do not have permission/)
})

// Every finance and commercial approve button must go through the password dialog.
const SITES = [
  'app/(dashboard)/commercial/markups/page.tsx', 'app/(dashboard)/commercial/fx-rates/page.tsx', 'app/(dashboard)/finance/supplier-settlements/page.tsx',
  'app/(dashboard)/finance/funding/page.tsx', 'components/clients/AgencyCreditPanel.tsx', 'components/finance/ExceptionPanel.tsx', 'components/reconciliation/ApprovalsPanel.tsx',
]
test('approve actions are wrapped in the step-up dialog', () => {
  for (const f of SITES) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    assert.match(text, /useStepUp\(\)/, f)
    assert.match(text, /\{dialog\}/, f)
  }
})
