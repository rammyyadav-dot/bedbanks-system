import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, UseGuards, PayloadTooLargeException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ApiTags } from '@nestjs/swagger'
import { HOTEL_IMAGE_ERROR_CODES, HOTEL_IMAGE_LIMITS, type HotelImageUpdate } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { HotelImagesService } from './hotel-images.service'

const rid = (req: Request) => (req as unknown as { requestId?: string }).requestId ?? null

/** Reads the request body after the guards have run, refusing as soon as it passes the limit (so an unauthenticated caller cannot stream data). */
async function readBody(req: Request, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  const tooLarge = () => new PayloadTooLargeException({ message: `An image can be at most ${max / 1024 / 1024} MB.`, code: HOTEL_IMAGE_ERROR_CODES.tooLarge })
  if (declared > max) throw tooLarge()
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > max) { req.destroy(); throw tooLarge() }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Hotel images (ADR 0027). Tenant identity comes from the session. Reads need supply.hotels.read; uploads, edits and deletes need
 * supply.hotels.manage. An upload sends the image bytes as the request body with the image content type; the alt text is a query parameter.
 */
@ApiTags('admin-hotel-images')
@Controller('admin/hotels/:hotelId/images')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class HotelImagesController {
  constructor(private readonly images: HotelImagesService) {}

  @Get() @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  list(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string) { return this.images.list(tenantId, hotelId) }

  @Post() @HttpCode(201) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  async upload(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Query('altText') altText: string, @Req() req: Request) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    return this.images.upload(tenantId, identity.user.id, hotelId, await readBody(req, HOTEL_IMAGE_LIMITS.maxBytes), type, altText, rid(req))
  }

  @Get(':imageId/content') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  async content(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('imageId') imageId: string, @Res() res: Response) {
    const file = await this.images.content(tenantId, hotelId, imageId)
    res.set({
      'Content-Type': file.contentType, 'Content-Length': String(file.data.length), ETag: `"${file.sha256}"`,
      'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    })
    res.status(200).end(file.data)
  }

  @Patch(':imageId') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  update(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('imageId') imageId: string, @Body() body: HotelImageUpdate, @Req() req: Request) {
    return this.images.update(tenantId, identity.user.id, hotelId, imageId, body ?? {}, rid(req))
  }

  @Delete(':imageId') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  remove(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('imageId') imageId: string, @Req() req: Request) {
    return this.images.remove(tenantId, identity.user.id, hotelId, imageId, rid(req))
  }
}
