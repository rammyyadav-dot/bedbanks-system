import { BadRequestException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { OperationsHotelsService } from './operations-hotels.service'
import type { PrismaService } from '../database/prisma.service'
const service = new OperationsHotelsService({} as PrismaService) as unknown as { baseWhere(tenantId: string, query: Record<string, unknown>): Prisma.HotelWhereInput }
describe('hotel directory search scope', () => {
  it('normalizes country without widening the authenticated tenant', () => {
    expect(service.baseWhere('tenant-a', { countryCode: 'ae', tenantId: 'evil' })).toMatchObject({ tenantId: 'tenant-a', countryCode: 'AE' })
    expect(() => service.baseWhere('tenant-a', { countryCode: 'A%' })).toThrow(BadRequestException)
  })
  it('searches city and supplier references literally within the tenant', () => {
    const where = service.baseWhere('tenant-a', { search: 'ref%_' })
    const and = where.AND as Prisma.HotelWhereInput[]
    expect(and[0]?.OR).toEqual(expect.arrayContaining([
      { city: { contains: 'ref\\%\\_', mode: 'insensitive' } },
      { mappings: { some: { tenantId: 'tenant-a', supplierHotelId: { startsWith: 'ref\\%\\_', mode: 'insensitive' } } } },
    ])); expect(where.tenantId).toBe('tenant-a')
  })
})
