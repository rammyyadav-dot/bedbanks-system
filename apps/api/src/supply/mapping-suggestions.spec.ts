import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { MappingService } from './mapping.service'

const hotel = { id: 'h1', name: 'DoubleTree by Hilton Dubai Al Jadaf', address: 'Al Jadaf Street', city: 'Dubai', countryCode: 'AE', latitude: null, longitude: null }

function build(options: { allowed?: boolean; indexed?: boolean; shortlist?: Array<{ hotelId: string }>; hotels?: unknown[] } = {}) {
  const raw: unknown[][] = [options.indexed === false ? [] : [{ one: 1 }], options.shortlist ?? [{ hotelId: 'h1', vectorSimilarity: 0.9, nameSimilarity: 0.9 }]]
  const findMany = jest.fn(async () => options.hotels ?? [hotel])
  const tx = { userRole: { count: async () => (options.allowed === false ? 0 : 1) }, $queryRaw: jest.fn(async () => raw.shift() ?? []), hotel: { findMany } }
  const prisma = { withTenant: async (_tenant: string, run: (t: unknown) => unknown) => run(tx) }
  return { service: new MappingService(prisma as never), findMany, tx }
}

describe('MappingService.suggestHotels', () => {
  it('requires the mappings read permission', async () => {
    await expect(build({ allowed: false }).service.suggestHotels('t1', 'u1', { name: 'DoubleTree' })).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('reports an unpopulated index instead of an empty match', async () => {
    const { service, findMany } = build({ indexed: false })
    await expect(service.suggestHotels('t1', 'u1', { name: 'DoubleTree' })).resolves.toEqual({ indexReady: false, suggestions: [] })
    expect(findMany).not.toHaveBeenCalled()
  })

  it('ranks the shortlisted hotels, scoped to the tenant, without exposing an auto-map flag', async () => {
    const { service, findMany } = build()
    const result = await service.suggestHotels('t1', 'u1', { name: 'Double Tree Hilton Al Jaddaf', address: 'Al Jadaf Street', city: 'Dubai', countryCode: 'ae' })
    expect(result.indexReady).toBe(true)
    expect(result.suggestions[0]).toMatchObject({ hotelId: 'h1', city: 'Dubai' })
    expect(result.suggestions[0]).not.toHaveProperty('autoMap')
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 't1', id: { in: ['h1'] } } }))
  })

  it('rejects malformed input', async () => {
    const { service } = build()
    await expect(service.suggestHotels('t1', 'u1', { name: 'x' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.suggestHotels('t1', 'u1', { name: 'DoubleTree', countryCode: 'UAE' })).rejects.toBeInstanceOf(BadRequestException)
  })
})
