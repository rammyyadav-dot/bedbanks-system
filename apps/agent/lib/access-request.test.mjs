import assert from 'node:assert/strict'
import test from 'node:test'
import { composeAccessEmail, emptyAccessRequest, validateAccessRequest } from './access-request.ts'

const valid = {
  ...emptyAccessRequest, firstName: 'Amal', lastName: 'Khan', jobTitle: 'Operations manager', agencyName: 'Gulf Travel LLC',
  workEmail: 'amal@gulftravel.example', confirmEmail: 'AMAL@gulftravel.example', phone: '+971 4 000 0000', country: 'United Arab Emirates',
  agencyType: 'Leisure travel agent', connectivity: 'Booking website (agent portal)', monthlyVolume: '100–999', consent: true,
}

test('accepts a complete request', () => assert.deepEqual(validateAccessRequest(valid), {}))

test('requires every mandatory field and consent', () => {
  const errors = validateAccessRequest(emptyAccessRequest)
  for (const key of ['firstName', 'lastName', 'jobTitle', 'agencyName', 'workEmail', 'phone', 'country', 'agencyType', 'connectivity', 'monthlyVolume', 'consent']) assert.ok(errors[key], key)
})

test('rejects personal mailboxes and mismatched confirmation', () => {
  assert.match(validateAccessRequest({ ...valid, workEmail: 'amal@gmail.com', confirmEmail: 'amal@gmail.com' }).workEmail, /agency email/)
  assert.ok(validateAccessRequest({ ...valid, confirmEmail: 'other@gulftravel.example' }).confirmEmail)
})

test('"Other" business type needs a description', () => {
  assert.ok(validateAccessRequest({ ...valid, agencyType: 'Other' }).agencyTypeOther)
  assert.deepEqual(validateAccessRequest({ ...valid, agencyType: 'Other', agencyTypeOther: 'Corporate events' }), {})
})

test('email composer addresses the verified contact and carries no credentials or demo claims', () => {
  const { href, body } = composeAccessEmail(valid)
  assert.ok(href.startsWith('mailto:hello@fbeds.com?subject='))
  assert.match(body, /Agency name: Gulf Travel LLC/)
  assert.doesNotMatch(body, /password|token/i)
})
