import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalPreview, buildAmendmentProposal, buildApproval, describeProposal, initialAmendmentForm, initialApprovalForm, minorToMajor, openAmendment } from './booking-amendment-ui'

const d = { booking: { checkIn: '2030-07-01', checkOut: '2030-07-05' }, rooms: [{ position: 1, roomName: 'Deluxe', adults: 2, children: 1, childAges: [7] }, { position: 2, roomName: 'Deluxe', adults: 2, children: 0, childAges: [] }] } as never
const TODAY = '2030-06-10'

test('the form starts as the booking is, and sending it unchanged sends nothing', () => {
  const form = initialAmendmentForm(d)
  assert.deepEqual(form.rooms.map((r) => [r.position, r.adults, r.children, r.childAges]), [[1, '2', '1', '7'], [2, '2', '0', '']])
  assert.deepEqual(buildAmendmentProposal(form, d, TODAY), { none: true })
})

test('only what differs is sent: dates, and the rooms whose head count changed', () => {
  const form = initialAmendmentForm(d); form.checkOut = '2030-07-07'; form.rooms[1].adults = '3'
  assert.deepEqual(buildAmendmentProposal(form, d, TODAY), { proposal: { checkOut: '2030-07-07', rooms: [{ position: 2, adults: 3, children: 0, childAges: [] }] } })
})

test('problems are shown before submitting, in the contract’s own words', () => {
  const past = initialAmendmentForm(d); past.checkIn = '2030-06-01'; past.checkOut = '2030-07-05'
  assert.match(JSON.stringify(buildAmendmentProposal(past, d, TODAY)), /past/)
  const ages = initialAmendmentForm(d); ages.rooms[0].children = '2'
  assert.match(JSON.stringify(buildAmendmentProposal(ages, d, TODAY)), /one age/)
  const junk = initialAmendmentForm(d); junk.rooms[1].adults = 'two'
  assert.match(JSON.stringify(buildAmendmentProposal(junk, d, TODAY)), /whole numbers/)
})

test('money is typed as a plain number and sent as integer minor units; nothing is rounded', () => {
  assert.equal(minorToMajor('73000', 'AED'), '730.00'); assert.equal(minorToMajor('1234500', 'AED'), '12345.00'); assert.equal(minorToMajor('1500', 'JPY'), '1500')
  const form = { sell: '950', net: '840.50', deadline: '' }
  assert.deepEqual(buildApproval(form, 'AED'), { approval: { sellMinor: '95000', netMinor: '84050' } })
  assert.deepEqual(buildApproval({ sell: '950', net: '', deadline: '' }, 'AED'), { approval: { sellMinor: '95000', netMinor: null } })
  for (const bad of [{ sell: '9.999', net: '', deadline: '' }, { sell: 'abc', net: '', deadline: '' }, { sell: '0', net: '', deadline: '' }, { sell: '100', net: '101', deadline: '' }, { sell: '100', net: 'x', deadline: '' }, { sell: '100', net: '', deadline: 'soon' }]) assert.ok('errors' in buildApproval(bad, 'AED'), JSON.stringify(bad))
  assert.equal(initialApprovalForm('AED', { sellMinor: '73000', netMinor: null }).net, '')
})

test('the approver sees the difference in words before confirming, and that nothing is charged here', () => {
  assert.match(approvalPreview('73000', { sell: '950', net: '', deadline: '' }, 'AED')?.text ?? '', /goes up by AED 220\.00.*awaiting Finance booking; nothing is charged/)
  assert.match(approvalPreview('73000', { sell: '700', net: '', deadline: '' }, 'AED')?.text ?? '', /goes down by AED 30\.00/)
  assert.equal(approvalPreview('73000', { sell: '730', net: '', deadline: '' }, 'AED')?.tone, 'same')
  assert.equal(approvalPreview('73000', { sell: '', net: '', deadline: '' }, 'AED'), null)
})

test('the open amendment is the one awaiting a decision; a proposal is described in words', () => {
  const a = { id: 'a1', status: 'REQUESTED', proposal: { checkOut: '2030-07-07', rooms: [{ position: 2, adults: 3, children: 0, childAges: [] }] }, before: { checkIn: '2030-07-01', checkOut: '2030-07-05', rooms: [{ position: 2, adults: 2, children: 0, childAges: [] }] } } as never
  assert.equal(openAmendment({ amendments: [{ status: 'APPROVED' } as never, a] })?.id, 'a1'); assert.equal(openAmendment({ amendments: [] }), null); assert.equal(openAmendment({}), null)
  assert.deepEqual(describeProposal(a), ['Stay 2030-07-01 → 2030-07-05 becomes 2030-07-01 → 2030-07-07', 'Room 2: 2 AD becomes 3 AD'])
})
