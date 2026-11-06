import {
  addDays, amendFinite, applyDelivery, availableInventory, effectiveOutcome, freeSaleConsumesInventory, holdsToExpire,
  hotelLocalDate, idempotencyDecision, inclusiveDates, planSalesBatch, postReleaseMode, releaseOnCancel, releasedContracted,
  remainingCap, reserveFinite, resolveRoomSales, sellableQuantity, stayNights, weekdayOf, type ReserveState,
} from './engine'
import type { RoomSalesRuleView as Rule } from '@bedbanks/contracts'

const rule = (patch: Partial<Rule>): Rule => ({
  roomTypeId: 'deluxe', stayDate: '2026-11-06', poolKey: '', planKey: '', channelKey: '', marketKey: '', contractKey: '',
  mode: 'FREE_SALE', salesCap: null, consumesInventory: true, overrideExpiresAt: null, ...patch,
})
const now = new Date('2026-11-06T08:00:00.000Z')
const resolve = (rules: Rule[], patch: Partial<Parameters<typeof resolveRoomSales>[0]> = {}) => resolveRoomSales({
  rules, roomTypeId: 'deluxe', ratePlanId: 'bar', poolId: 'pool', contractId: 'c1', stayDate: '2026-11-06', channel: 'PORTAL', market: 'AE', now, consumed: 0, ...patch,
})

describe('stay dates and hotel time', () => {
  it('booking nights are check-in inclusive and check-out exclusive', () => {
    expect(stayNights('2026-11-06', '2026-11-09')).toEqual(['2026-11-06', '2026-11-07', '2026-11-08'])
    expect(stayNights('2026-11-06', '2026-11-06')).toBeNull()
  })
  it('bulk editing is inclusive of the end stay date', () => {
    expect(inclusiveDates('2026-11-06', '2026-11-08')).toEqual(['2026-11-06', '2026-11-07', '2026-11-08'])
    expect(inclusiveDates('2026-11-08', '2026-11-06')).toBeNull()
  })
  it('uses the hotel calendar date, not the UTC date, around Dubai midnight', () => {
    expect(hotelLocalDate(new Date('2026-11-05T19:59:00.000Z'), 'Asia/Dubai')).toBe('2026-11-05')
    expect(hotelLocalDate(new Date('2026-11-05T20:30:00.000Z'), 'Asia/Dubai')).toBe('2026-11-06')
    expect(hotelLocalDate(now, 'Not/AZone')).toBeNull()
  })
  it('weekdays follow the stay date', () => {
    expect(weekdayOf('2026-11-06')).toBe('FRI')
    expect(addDays('2026-11-06', 2)).toBe('2026-11-08')
  })
})

describe('inventory and caps', () => {
  it('computes available inventory once and does not subtract excluded out-of-service rooms again', () => {
    expect(availableInventory({ contracted: 10, approvedAdjustment: 2, confirmed: 6, activeHolds: 1, blocked: 1, blockedAlreadyExcluded: false })).toBe(4)
    expect(availableInventory({ contracted: 10, approvedAdjustment: 0, confirmed: 6, activeHolds: 1, blocked: 3, blockedAlreadyExcluded: true })).toBe(3)
  })
  it('sellable quantity is the lower of inventory and remaining cap', () => {
    expect(remainingCap(5, 3, 1)).toBe(1)
    expect(sellableQuantity(4, 1, false)).toBe(1)
    expect(sellableQuantity(4, null, false)).toBe(4)
    expect(sellableQuantity(null, null, true)).toBeNull()
  })
  it('a cap below commitments blocks further sales and does not change confirmed units', () => {
    const resolved = resolve([rule({ mode: 'LIMITED', salesCap: 2 })], { consumed: 4 })
    expect(resolved.overCap).toBe(true)
    expect(resolved.capRemaining).toBe(-2)
    const effect = effectiveOutcome({ resolved, verifiedRate: true, quarantinedRate: false, inventoryRemaining: 6, legacyMode: 'ALLOTMENT', legacyStop: false, roomsRequested: 1 })
    expect(effect.outcome).toBe('UNAVAILABLE')
    expect(effect.reasons.join(' ')).toMatch(/below existing commitments/)
  })
})

describe('precedence', () => {
  it('a narrower Free Sale cannot reopen a broader Stop Sale, including another rate plan', () => {
    const rules = [rule({ mode: 'STOP_SALE' }), rule({ mode: 'FREE_SALE', planKey: 'breakfast', consumesInventory: true })]
    expect(resolve(rules, { ratePlanId: 'breakfast' }).stopSale).toBe(true)
    expect(resolve(rules, { ratePlanId: 'room-only' }).stopSale).toBe(true)
    expect(resolve(rules, { ratePlanId: 'room-only' }).configuredMode).toBe('STOP_SALE')
  })
  it('a channel stop does not block a different channel, and an all-channel stop does', () => {
    const channel = [rule({ mode: 'STOP_SALE', channelKey: 'API' })]
    expect(resolve(channel, { channel: 'PORTAL' }).stopSale).toBe(false)
    expect(resolve(channel, { channel: 'API' }).stopSale).toBe(true)
    expect(resolve([rule({ mode: 'STOP_SALE' })], { channel: 'PORTAL' }).stopSale).toBe(true)
  })
  it('overlapping caps keep the smaller remaining allowance', () => {
    const rules = [rule({ mode: 'LIMITED', salesCap: 5 }), rule({ mode: 'LIMITED', salesCap: 2, planKey: 'bar' })]
    expect(resolve(rules, { consumed: 1 }).capRemaining).toBe(1)
  })
  it('an expired manual override no longer applies', () => {
    const expired = resolve([rule({ mode: 'STOP_SALE', overrideExpiresAt: '2026-11-01T00:00:00.000Z' })])
    expect(expired.applicable).toBe(0)
  })
  it('painting Free Sale on an allocated contract still consumes inventory', () => {
    expect(freeSaleConsumesInventory('GUARANTEED')).toBe(true)
    expect(freeSaleConsumesInventory(null)).toBe(true)
    expect(freeSaleConsumesInventory('FREE_SALE')).toBe(false)
    const planned = planSalesBatch({
      roomTypeIds: ['deluxe'], from: '2026-11-06', to: '2026-11-06', weekdays: [], mode: 'FREE_SALE', salesCap: null,
      deadlineHours: null, owner: null, escalation: null, reason: 'Open the weekend', confirmBroadReopen: false, canReopenBroad: false,
      allotmentType: 'GUARANTEED', current: [],
    })
    expect(planned.consumesInventory).toBe(true)
    expect(planned.ok).toBe(true)
  })
  it('On Request beyond a finite allocation is refused unless the contract authorizes free sale', () => {
    const finite = planSalesBatch({
      roomTypeIds: ['deluxe'], from: '2026-11-06', to: '2026-11-06', weekdays: ['FRI'], mode: 'ON_REQUEST', salesCap: null,
      deadlineHours: 24, owner: 'Reservations', escalation: 'Duty manager after 4 hours', reason: 'Supplier must confirm', confirmBroadReopen: false, canReopenBroad: false,
      allotmentType: 'NON_GUARANTEED', current: [],
    })
    expect(finite.consumesInventory).toBe(true)
    const open = { ...finite, consumesInventory: undefined }
    expect(open).toBeTruthy()
    const authorized = planSalesBatch({
      roomTypeIds: ['deluxe'], from: '2026-11-06', to: '2026-11-06', weekdays: [], mode: 'ON_REQUEST', salesCap: null,
      deadlineHours: 24, owner: 'Reservations', escalation: 'Duty manager after 4 hours', reason: 'Contractual request', confirmBroadReopen: false, canReopenBroad: false,
      allotmentType: 'FREE_SALE', current: [],
    })
    expect(authorized.consumesInventory).toBe(false)
  })
  it('reopening a room-wide stop needs authority and confirmation, and a failed batch keeps every cell', () => {
    const current = [{ roomTypeId: 'deluxe', stayDate: '2026-11-06', expectedVersion: 2, current: { version: 3, mode: 'STOP_SALE' as const, planKey: '', channelKey: '', marketKey: '', contractKey: '' } }]
    const denied = planSalesBatch({
      roomTypeIds: ['deluxe'], from: '2026-11-06', to: '2026-11-06', weekdays: [], mode: 'FREE_SALE', salesCap: null,
      deadlineHours: null, owner: null, escalation: null, reason: 'Supplier reopened', confirmBroadReopen: true, canReopenBroad: false,
      allotmentType: 'GUARANTEED', current,
    })
    expect(denied.ok).toBe(false)
    expect(denied.conflicts.length + denied.errors.length).toBeGreaterThan(0)
    expect(denied.cells).toHaveLength(1)
  })
  it('missing and quarantined rates are not sellable, and a green rule is not a confirmation', () => {
    const open = resolve([rule({ mode: 'FREE_SALE' })])
    expect(effectiveOutcome({ resolved: open, verifiedRate: false, quarantinedRate: false, inventoryRemaining: 4, legacyMode: 'ALLOTMENT', legacyStop: false, roomsRequested: 1 }).outcome).toBe('UNAVAILABLE')
    expect(effectiveOutcome({ resolved: open, verifiedRate: false, quarantinedRate: true, inventoryRemaining: 4, legacyMode: 'ALLOTMENT', legacyStop: false, roomsRequested: 1 }).outcome).toBe('UNAVAILABLE')
    const instant = effectiveOutcome({ resolved: open, verifiedRate: true, quarantinedRate: false, inventoryRemaining: 4, legacyMode: 'ALLOTMENT', legacyStop: false, roomsRequested: 1 })
    expect(instant.outcome).toBe('INSTANT')
    expect(instant.reasons.join(' ')).toMatch(/only while inventory/)
    expect(effectiveOutcome({ resolved: resolve([]), verifiedRate: true, quarantinedRate: false, inventoryRemaining: 4, legacyMode: null, legacyStop: false, roomsRequested: 1 }).outcome).toBe('NOT_CONFIGURED')
  })
})

describe('booking transactions', () => {
  const stock = () => {
    const state: ReserveState = { stock: new Map([['2026-11-06', { id: 'n', available: 1, version: 1 }], ['2026-11-07', { id: 'm', available: 1, version: 1 }]]), seen: new Map() }
    return state
  }
  it('rejects the whole stay when any night fails and confirms only when every night passes', () => {
    const rejected = reserveFinite(stock(), { idempotencyKey: 'a', fingerprint: 'fa', nights: ['2026-11-06', '2026-11-07'], rooms: 2 })
    expect(rejected.result).toBe('rejected')
    expect(rejected.state.stock.get('2026-11-06')!.available).toBe(1)
    const accepted = reserveFinite(stock(), { idempotencyKey: 'b', fingerprint: 'fb', nights: ['2026-11-06', '2026-11-07'], rooms: 1 })
    expect(accepted.result).toBe('reserved')
    expect(accepted.state.stock.get('2026-11-07')!.available).toBe(0)
  })
  it('two buyers cannot both take the last room, and a retry does not consume twice', () => {
    const first = reserveFinite(stock(), { idempotencyKey: 'one', fingerprint: 'f1', nights: ['2026-11-06'], rooms: 1 })
    const second = reserveFinite(first.state, { idempotencyKey: 'two', fingerprint: 'f2', nights: ['2026-11-06'], rooms: 1 })
    const retry = reserveFinite(first.state, { idempotencyKey: 'one', fingerprint: 'f1', nights: ['2026-11-06'], rooms: 1 })
    expect(first.result).toBe('reserved')
    expect(second.result).toBe('rejected')
    expect(retry.result).toBe('replay')
    expect(retry.state.stock.get('2026-11-06')!.available).toBe(0)
    const clash = reserveFinite(first.state, { idempotencyKey: 'one', fingerprint: 'other', nights: ['2026-11-06'], rooms: 1 })
    expect(clash.result).toBe('conflict')
  })
  it('a failed amendment preserves the original stay, and a successful one releases it only after the replacement is secured', () => {
    const held = reserveFinite(stock(), { idempotencyKey: 'book', fingerprint: 'book', nights: ['2026-11-06'], rooms: 1 }).state
    const failed = amendFinite(held, { nights: ['2026-11-06'], rooms: 1 }, { idempotencyKey: 'amend', fingerprint: 'amend', nights: ['2026-11-07'], rooms: 2 })
    expect(failed.result).toBe('rejected')
    expect(failed.state.stock.get('2026-11-06')!.available).toBe(0)
    const moved = amendFinite(held, { nights: ['2026-11-06'], rooms: 1 }, { idempotencyKey: 'amend', fingerprint: 'amend', nights: ['2026-11-07'], rooms: 1 })
    expect(moved.result).toBe('reserved')
    expect(moved.state.stock.get('2026-11-06')!.available).toBe(1)
    expect(moved.state.stock.get('2026-11-07')!.available).toBe(0)
  })
  it('cancellation releases according to policy and expired holds are the only ones released', () => {
    expect(releaseOnCancel('RELEASE', 2)).toBe(2)
    expect(releaseOnCancel('RETAIN', 2)).toBe(0)
    const ids = holdsToExpire([
      { id: 'due', status: 'ACTIVE', expiresAt: '2026-11-06T07:00:00.000Z' },
      { id: 'live', status: 'ACTIVE', expiresAt: '2026-11-06T09:00:00.000Z' },
      { id: 'done', status: 'RELEASED', expiresAt: '2026-11-06T07:00:00.000Z' },
    ], now)
    expect(ids).toEqual(['due'])
  })
  it('release returns only unused allocation and post-release policy is explicit', () => {
    expect(releasedContracted({ contracted: 10, approvedAdjustment: 1, confirmed: 4, activeHolds: 1, blocked: 0, blockedAlreadyExcluded: false })).toEqual({ contracted: 4, overCommitment: false })
    expect(postReleaseMode('CLOSED')).toBe('STOP_SALE')
    expect(postReleaseMode('ON_REQUEST')).toBe('ON_REQUEST')
    expect(postReleaseMode('AUTHORIZED_FREE_SALE')).toBe('FREE_SALE')
  })
})

describe('distribution and idempotency', () => {
  it('keeps internal save distinct from acknowledgement and retries a failure once', () => {
    const pending = { state: 'PENDING' as const, attempts: 0, lastError: null }
    const failed = applyDelivery(pending, { acknowledged: false, error: 'Channel timed out' })
    expect(failed).toEqual({ state: 'FAILED', attempts: 1, lastError: 'Channel timed out' })
    const acked = applyDelivery(failed, { acknowledged: true })
    expect(acked.state).toBe('ACKNOWLEDGED')
    expect(applyDelivery(acked, { acknowledged: false, error: 'again' })).toEqual(acked)
  })
  it('a reused idempotency key with a different body conflicts', () => {
    expect(idempotencyDecision(null, 'a')).toBe('new')
    expect(idempotencyDecision('a', 'a')).toBe('replay')
    expect(idempotencyDecision('a', 'b')).toBe('conflict')
  })
})

describe('shared stock across rate plans', () => {
  it('two plans read one pool remainder rather than a copy each', () => {
    const shared = resolve([rule({ mode: 'FREE_SALE', consumesInventory: true })], { consumed: 4 })
    const breakfast = effectiveOutcome({ resolved: shared, verifiedRate: true, quarantinedRate: false, inventoryRemaining: 1, legacyMode: 'ALLOTMENT', legacyStop: false, roomsRequested: 1 })
    const roomOnly = effectiveOutcome({ resolved: resolve([rule({ mode: 'FREE_SALE', consumesInventory: true })], { ratePlanId: 'room-only', consumed: 4 }), verifiedRate: true, quarantinedRate: false, inventoryRemaining: 1, legacyMode: 'ALLOTMENT', legacyStop: false, roomsRequested: 2 })
    expect(breakfast.outcome).toBe('INSTANT')
    expect(roomOnly.outcome).toBe('UNAVAILABLE')
    expect(roomOnly.reasons.join(' ')).toMatch(/Not enough remaining inventory/)
  })
})
