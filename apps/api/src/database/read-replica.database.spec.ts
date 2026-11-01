import { BookingOpsReadReplica } from './read-replica.database'

describe('BookingOpsReadReplica.configured (ADR 0074)', () => {
  const primary = 'postgresql://api@primary/db'
  const ops = 'postgresql://booking@primary/db'
  it('is off when no replica URL is set', () => {
    expect(new BookingOpsReadReplica({ DATABASE_URL: primary, BOOKING_OPS_DATABASE_URL: ops }).configured()).toBe(false)
  })
  it('is on only for an endpoint that differs from both primary credentials', () => {
    expect(new BookingOpsReadReplica({ DATABASE_URL: primary, BOOKING_OPS_DATABASE_URL: ops, BOOKING_OPS_READ_REPLICA_URL: 'postgresql://booking@replica/db' }).configured()).toBe(true)
    expect(new BookingOpsReadReplica({ DATABASE_URL: primary, BOOKING_OPS_DATABASE_URL: ops, BOOKING_OPS_READ_REPLICA_URL: ops }).configured()).toBe(false)
    expect(new BookingOpsReadReplica({ DATABASE_URL: primary, BOOKING_OPS_READ_REPLICA_URL: primary }).configured()).toBe(false)
  })
})
