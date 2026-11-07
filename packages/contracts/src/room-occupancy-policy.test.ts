import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  childAgeLabel, compatibilityNote, countedGuests, deriveOccupancyPolicy, explainParty, normaliseOccupancyPolicy,
  occupancyMatrix, occupancyPolicyTightened, parseOccupancyPolicy, policyProblems,
} from './room-occupancy-policy'

const caps = { maxAdults: 3, maxChildren: 2, maxOccupancy: 4 }

describe('room occupancy policy', () => {
  it('accepts the extranet example: 4 guests, 3 adults, 2 children, with the standard age bands', () => {
    const policy = deriveOccupancyPolicy(caps, false)
    policy.maxAdultsWithChildren = 2
    policy.minAdults = 1
    assert.deepEqual(policyProblems(policy, caps), [])
    assert.equal(childAgeLabel(policy, caps.maxChildren), 'Children: 0–11 yrs')
  })

  it('refuses a maximum below the adult cap and a maximum above adults plus children', () => {
    const policy = deriveOccupancyPolicy({ maxAdults: 2, maxChildren: 2, maxOccupancy: 2 }, false)
    assert.match(policyProblems(policy, { maxAdults: 2, maxChildren: 0, maxOccupancy: 1 }).join(' '), /must be at least the adult maximum/)
    assert.match(policyProblems(policy, { maxAdults: 2, maxChildren: 2, maxOccupancy: 5 }).join(' '), /cannot exceed maxAdults plus maxChildren/)
  })

  it('keeps age bands contiguous and prices a child share in basis points', () => {
    const policy = deriveOccupancyPolicy(caps, false)
    policy.ageBands[1] = { ...policy.ageBands[1], minAge: 4 }
    assert.match(policyProblems(policy, caps).join(' '), /no gap and no overlap/)
    const overlapping = deriveOccupancyPolicy(caps, false)
    overlapping.ageBands[2] = { ...overlapping.ageBands[2], charge: 'PERCENT', percentBp: 1000 }
    assert.match(policyProblems(overlapping, caps).join(' '), /base rate/)
    const priced = deriveOccupancyPolicy(caps, true)
    assert.equal(priced.ageBands[1]?.percentBp, 5000)
    assert.match(normaliseOccupancyPolicy({ ...priced, percentOfAdult: 0.5 }, caps).errors.join(' '), /percentOfAdult/)
  })

  it('classifies the matrix: 3 adults with 2 children do not fit in 4, 2 adults with 2 children do', () => {
    const policy = deriveOccupancyPolicy(caps, false)
    policy.maxAdultsWithChildren = 2
    const cells = occupancyMatrix(policy, caps)
    const at = (adults: number, children: number) => cells.find((cell) => cell.adults === adults && cell.children === children)
    assert.equal(at(3, 2)?.state, 'invalid')
    assert.equal(at(2, 2)?.state, 'bookable')
    assert.equal(at(3, 0)?.state, 'bookable')
    assert.equal(at(0, 2)?.state, 'invalid')
    policy.blocked = [{ adults: 2, children: 2 }]
    assert.equal(explainParty(policy, caps, 2, 2).state, 'blocked')
  })

  it('lets one sharing child drop out of the count and refuses an extra bed the room does not offer', () => {
    const policy = deriveOccupancyPolicy({ maxAdults: 2, maxChildren: 1, maxOccupancy: 2 }, false)
    policy.sharingBedAllowed = true
    policy.baseOccupancy = 2
    assert.equal(countedGuests(policy, 2, 1), 2)
    assert.equal(explainParty(policy, { maxAdults: 2, maxChildren: 1, maxOccupancy: 2 }, 2, 1).state, 'bookable')
    policy.sharingBedAllowed = false
    policy.extraBedCountsTowardMax = false
    policy.maxExtraBeds = 1
    policy.childExtraBedAllowed = false
    policy.adultExtraBedAllowed = true
    assert.equal(explainParty(policy, { maxAdults: 2, maxChildren: 1, maxOccupancy: 2 }, 2, 1).state, 'invalid')
  })

  it('treats a lower cap or a new blocked cell as a tightening, and the first profile as not one', () => {
    const before = deriveOccupancyPolicy(caps, false)
    const after = { ...before, blocked: [{ adults: 2, children: 1 }] }
    assert.equal(occupancyPolicyTightened(before, after, caps, caps), true)
    assert.equal(occupancyPolicyTightened(null, before, caps, caps), false)
    assert.equal(occupancyPolicyTightened(before, before, caps, { ...caps, maxOccupancy: 3 }), true)
  })

  it('reads a stored profile and ignores a malformed one', () => {
    const policy = deriveOccupancyPolicy(caps, false)
    assert.deepEqual(parseOccupancyPolicy({ occupancyPolicy: policy, description: 'King' }, caps)?.ageBands.length, 3)
    const room = { maxAdults: 2, maxChildren: 1, maxOccupancy: 3 }
    const stored = deriveOccupancyPolicy(room, true)
    assert.equal(parseOccupancyPolicy({ occupancyPolicy: stored }, room)?.maxExtraBeds, 1)
    assert.equal(parseOccupancyPolicy({ occupancyPolicy: { ...stored, ageBands: [] } }, room), null)
    assert.equal(parseOccupancyPolicy({}, room), null)
    assert.match(compatibilityNote(stored, room), /Contract child supplements stay on the contract/)
  })
})
