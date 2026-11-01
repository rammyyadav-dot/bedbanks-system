import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { ListBookingsQueryDto } from './list-bookings.dto'

const check = async (input: Record<string, unknown>) => (await validate(plainToInstance(ListBookingsQueryDto, input), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property)

describe('ListBookingsQueryDto', () => {
  it('accepts an empty query and every documented filter', async () => {
    expect(await check({})).toEqual([])
    expect(await check({ status: 'CONFIRMED', checkInFrom: '2099-01-01', checkInTo: '2099-02-01', reference: 'FB-ABC', limit: '50', cursor: 'abc' })).toEqual([])
  })
  it('bounds the page size and refuses unknown or injected parameters', async () => {
    expect(await check({ limit: '0' })).toEqual(['limit'])
    expect(await check({ limit: '51' })).toEqual(['limit'])
    expect(await check({ supplierId: 'x' })).toEqual(['supplierId'])
    expect(await check({ tenantId: 'x' })).toEqual(['tenantId'])
    expect(await check({ reference: "' OR 1=1" })).toEqual(['reference'])
    expect(await check({ status: 'BOGUS' })).toEqual(['status'])
  })
})
