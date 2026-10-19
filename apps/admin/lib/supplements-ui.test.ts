import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blankSupplement, describeSupplement, supplementFromForm } from './supplements-ui'

test('a supplement form becomes a term in minor units (ADR 0067)', () => {
  assert.deepEqual(supplementFromForm({ ...blankSupplement, name: ' Gala dinner ', amount: '250.50', stayFrom: '2026-12-31', stayTo: '2026-12-31' }, 'AED'),
    { kind: 'COMPULSORY', name: 'Gala dinner', boardBasisId: null, ratePlanId: null, basis: 'PER_PERSON', frequency: 'PER_STAY', amountMinor: '25050', currency: 'AED', stayFrom: '2026-12-31', stayTo: '2026-12-31' })
  assert.match(String(supplementFromForm({ ...blankSupplement, kind: 'BOARD', name: 'HB', amount: '60' }, 'AED')), /Choose the board/)
  assert.match(String(supplementFromForm({ ...blankSupplement, name: 'X', amount: '0' }, 'AED')), /greater than zero/)
  assert.match(String(supplementFromForm({ ...blankSupplement, name: 'X', amount: '1', stayFrom: '2027-01-02', stayTo: '2027-01-01' }, 'AED')), /on or after/)
})

test('a supplement reads as the contract states it', () => {
  assert.equal(describeSupplement({ name: 'Half board', basis: 'PER_ADULT', frequency: 'PER_NIGHT', amountMinor: '6000', currency: 'AED', stayFrom: null, stayTo: null }, (m, c) => `${c} ${m}`, 'HB'), 'Half board (HB): AED 6000 per adult, per night')
})
