import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { guardedRead } from '../admin-operations/operations-read'
import { idParam } from '../admin-operations/query-params'

/**
 * Serves a hotel image to an Agent (ADR 0027). Only images of PUBLISHED hotels of the caller's tenant are served; a draft, suspended
 * or foreign hotel is a 404, exactly like a missing image. Search already hides restricted hotels, and an image is catalogue content,
 * so this does not re-apply per-agency distribution restrictions.
 */
@Injectable()
export class AgentHotelImageService {
  constructor(private readonly prisma: PrismaService) {}

  async content(tenantId: string, hotelIdRaw: string, imageIdRaw: string): Promise<{ data: Buffer; contentType: string; sha256: string }> {
    const hotelId = idParam('hotelId', hotelIdRaw); const imageId = idParam('imageId', imageIdRaw)
    if (!hotelId || !imageId) throw new NotFoundException('Image not found')
    return guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.hotelImage.findFirst({ where: { id: imageId, hotelId, tenantId, hotel: { tenantId, contentStatus: 'COMPLETE' } }, select: { data: true, contentType: true, sha256: true } })
      if (!row) throw new NotFoundException('Image not found')
      return { data: Buffer.from(row.data), contentType: row.contentType, sha256: row.sha256 }
    }))
  }
}
