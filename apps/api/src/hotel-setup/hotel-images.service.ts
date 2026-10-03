import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException, UnprocessableEntityException, UnsupportedMediaTypeException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import { HOTEL_IMAGE_ERROR_CODES, HOTEL_IMAGE_LIMITS, type HotelImageList, type HotelImageUpdate, type HotelImageView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { guardedRead } from '../admin-operations/operations-read'
import { idParam } from '../admin-operations/query-params'
import { isAllowedType, probeImage } from './hotel-image-probe'

type Tx = Prisma.TransactionClient
/** Everything except the bytes: list queries must never read the "data" column. */
const META = { id: true, contentType: true, bytes: true, width: true, height: true, altText: true, sortOrder: true, isPrimary: true, uploadedById: true, createdAt: true } as const
type Row = Prisma.HotelImageGetPayload<{ select: typeof META }>
const UPLOADED = 'hotel.image.uploaded'; const UPDATED = 'hotel.image.updated'; const DELETED = 'hotel.image.deleted'

/**
 * Hotel images (ADR 0027). The type and size are read from the bytes, never trusted from the client. Every write for one hotel takes a
 * per-hotel advisory lock, so the image count, the single primary and the ordering stay consistent under concurrent requests.
 * Audit events carry ids, sizes and field names only; never the file, its name or its alt text.
 */
@Injectable()
export class HotelImagesService {
  constructor(private readonly prisma: PrismaService) {}

  private async hotel(tx: Tx, tenantId: string, hotelIdRaw: string): Promise<string> {
    const id = idParam('hotelId', hotelIdRaw)
    if (!id) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    return hotel.id
  }
  private lock(tx: Tx, hotelId: string) { return tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hotel-images:${hotelId}`}, 0))`) }
  private view(hotelId: string, r: Row): HotelImageView {
    return { id: r.id, contentType: r.contentType as HotelImageView['contentType'], bytes: r.bytes, width: r.width, height: r.height, altText: r.altText, sortOrder: r.sortOrder, isPrimary: r.isPrimary, uploadedById: r.uploadedById, createdAt: r.createdAt.toISOString(), contentPath: `/admin/hotels/${hotelId}/images/${r.id}/content` }
  }
  private async listIn(tx: Tx, tenantId: string, hotelId: string): Promise<HotelImageList> {
    const rows = await tx.hotelImage.findMany({ where: { tenantId, hotelId }, select: META, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
    return { hotelId, items: rows.map((r) => this.view(hotelId, r)), limits: HOTEL_IMAGE_LIMITS }
  }
  private altText(raw: unknown): string {
    const alt = typeof raw === 'string' ? raw.trim() : ''
    if (alt.length < 1 || alt.length > HOTEL_IMAGE_LIMITS.altTextMax) throw new BadRequestException({ message: [`altText: required, 1 to ${HOTEL_IMAGE_LIMITS.altTextMax} characters`], error: 'Bad Request' })
    return alt
  }

  async list(tenantId: string, hotelId: string): Promise<HotelImageList> {
    return guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => this.listIn(tx, tenantId, await this.hotel(tx, tenantId, hotelId))))
  }

  async upload(tenantId: string, userId: string, hotelIdRaw: string, bytes: Buffer, declaredType: string, altRaw: unknown, requestId: string | null): Promise<HotelImageView> {
    if (!isAllowedType(declaredType) || bytes.length === 0) throw new UnsupportedMediaTypeException({ message: 'Send the image itself as image/jpeg, image/png or image/webp.', code: HOTEL_IMAGE_ERROR_CODES.unsupportedType })
    if (bytes.length > HOTEL_IMAGE_LIMITS.maxBytes) throw new PayloadTooLargeException({ message: `An image can be at most ${HOTEL_IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.`, code: HOTEL_IMAGE_ERROR_CODES.tooLarge })
    const alt = this.altText(altRaw)
    const probe = probeImage(bytes)
    if (!probe || probe.contentType !== declaredType) throw new UnsupportedMediaTypeException({ message: 'The file is not a valid JPEG, PNG or WebP image.', code: HOTEL_IMAGE_ERROR_CODES.unsupportedType })
    const { minWidth, minHeight, maxWidth, maxHeight } = HOTEL_IMAGE_LIMITS
    if (probe.width < minWidth || probe.height < minHeight || probe.width > maxWidth || probe.height > maxHeight) {
      throw new UnprocessableEntityException({ message: `Images must be between ${minWidth}x${minHeight} and ${maxWidth}x${maxHeight} pixels.`, code: HOTEL_IMAGE_ERROR_CODES.badDimensions })
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const hotelId = await this.hotel(tx, tenantId, hotelIdRaw)
        await this.lock(tx, hotelId)
        const existing = await tx.hotelImage.findFirst({ where: { hotelId, sha256 }, select: { id: true } })
        if (existing) throw new ConflictException({ message: 'This image is already on the hotel.', code: HOTEL_IMAGE_ERROR_CODES.duplicate, details: { existingImageId: existing.id } })
        const agg = await tx.hotelImage.aggregate({ where: { tenantId, hotelId }, _count: true, _max: { sortOrder: true } })
        if (agg._count >= HOTEL_IMAGE_LIMITS.maxPerHotel) throw new ConflictException({ message: `A hotel can have at most ${HOTEL_IMAGE_LIMITS.maxPerHotel} images.`, code: HOTEL_IMAGE_ERROR_CODES.limitReached })
        const row = await tx.hotelImage.create({
          data: { tenantId, hotelId, contentType: probe.contentType, bytes: bytes.length, width: probe.width, height: probe.height, sha256, altText: alt, sortOrder: (agg._max.sortOrder ?? -1) + 1, isPrimary: agg._count === 0, data: bytes, uploadedById: userId },
          select: META,
        })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: UPLOADED, entityType: 'hotel', entityId: hotelId, payload: { outcome: 'allowed', requestId, imageId: row.id, bytes: row.bytes, width: row.width, height: row.height, contentType: row.contentType, primary: row.isPrimary } as Prisma.InputJsonValue } })
        return this.view(hotelId, row)
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new ConflictException({ message: 'This image is already on the hotel.', code: HOTEL_IMAGE_ERROR_CODES.duplicate })
      throw error
    }
  }

  async update(tenantId: string, userId: string, hotelIdRaw: string, imageIdRaw: string, body: HotelImageUpdate, requestId: string | null): Promise<HotelImageList> {
    const imageId = idParam('imageId', imageIdRaw)
    if (!imageId) throw new BadRequestException('Invalid imageId')
    const keys = Object.keys(body ?? {})
    const errors: string[] = []
    for (const k of keys) if (!['altText', 'sortOrder', 'isPrimary'].includes(k)) errors.push(`${k}: is not an editable field`)
    if (keys.length === 0) errors.push('Send at least one of altText, sortOrder, isPrimary')
    if (body?.sortOrder !== undefined && (!Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 1000)) errors.push('sortOrder: whole number from 0 to 1000')
    if (body?.isPrimary !== undefined && body.isPrimary !== true) errors.push('isPrimary: can only be set to true; choose another image to replace the primary')
    if (errors.length) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    const alt = body.altText !== undefined ? this.altText(body.altText) : undefined
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotelId = await this.hotel(tx, tenantId, hotelIdRaw)
      await this.lock(tx, hotelId)
      const current = await tx.hotelImage.findFirst({ where: { id: imageId, hotelId, tenantId }, select: { id: true } })
      if (!current) throw new NotFoundException('Image not found')
      if (body.isPrimary) await tx.hotelImage.updateMany({ where: { hotelId, tenantId, isPrimary: true, NOT: { id: imageId } }, data: { isPrimary: false } })
      await tx.hotelImage.update({ where: { id: imageId }, data: { ...(alt !== undefined && { altText: alt }), ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }), ...(body.isPrimary && { isPrimary: true }) } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: UPDATED, entityType: 'hotel', entityId: hotelId, payload: { outcome: 'allowed', requestId, imageId, fields: keys.sort() } as Prisma.InputJsonValue } })
      return this.listIn(tx, tenantId, hotelId)
    })
  }

  async remove(tenantId: string, userId: string, hotelIdRaw: string, imageIdRaw: string, requestId: string | null): Promise<HotelImageList> {
    const imageId = idParam('imageId', imageIdRaw)
    if (!imageId) throw new BadRequestException('Invalid imageId')
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotelId = await this.hotel(tx, tenantId, hotelIdRaw)
      await this.lock(tx, hotelId)
      const current = await tx.hotelImage.findFirst({ where: { id: imageId, hotelId, tenantId }, select: { id: true, isPrimary: true } })
      if (!current) throw new NotFoundException('Image not found')
      await tx.hotelImage.delete({ where: { id: imageId } })
      let promoted: string | null = null
      if (current.isPrimary) {
        const next = await tx.hotelImage.findFirst({ where: { hotelId, tenantId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true } })
        if (next) { await tx.hotelImage.update({ where: { id: next.id }, data: { isPrimary: true } }); promoted = next.id }
      }
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: DELETED, entityType: 'hotel', entityId: hotelId, payload: { outcome: 'allowed', requestId, imageId, wasPrimary: current.isPrimary, promotedImageId: promoted } as Prisma.InputJsonValue } })
      return this.listIn(tx, tenantId, hotelId)
    })
  }

  /** The stored bytes of one image of this hotel and tenant. */
  async content(tenantId: string, hotelIdRaw: string, imageIdRaw: string): Promise<{ data: Buffer; contentType: string; sha256: string }> {
    const imageId = idParam('imageId', imageIdRaw)
    if (!imageId) throw new BadRequestException('Invalid imageId')
    return guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const hotelId = await this.hotel(tx, tenantId, hotelIdRaw)
      const row = await tx.hotelImage.findFirst({ where: { id: imageId, hotelId, tenantId }, select: { data: true, contentType: true, sha256: true } })
      if (!row) throw new NotFoundException('Image not found')
      return { data: Buffer.from(row.data), contentType: row.contentType, sha256: row.sha256 }
    }))
  }
}
