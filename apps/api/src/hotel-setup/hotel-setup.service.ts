import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  HOTEL_PROFILE_STATUSES, type HotelContacts, type HotelPolicies, type HotelProfileStatus, type HotelSetupSave, type HotelSetupSaved, type HotelSetupStatusChange, type HotelSetupView,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { guardedRead } from '../admin-operations/operations-read'
import { idParam } from '../admin-operations/query-params'
import { setupToken } from './hotel-setup-shared'
import { assessCompleteness, normaliseSave, regressions, type CurrentSetup } from './hotel-setup-rules'

const STATUS_CHANGED = 'hotel.setup.status_changed'
const SAVED = 'hotel.setup.updated'
const KEY = /^[A-Za-z0-9_.:-]{8,80}$/

type Tx = Prisma.TransactionClient
type HotelRow = NonNullable<Awaited<ReturnType<Tx['hotel']['findFirst']>>>
type ProfileRow = NonNullable<Awaited<ReturnType<Tx['hotelProfile']['findFirst']>>>

const asContacts = (value: Prisma.JsonValue | undefined): HotelContacts => (value && typeof value === 'object' && !Array.isArray(value) ? (value as HotelContacts) : {})
const asPolicies = (value: Prisma.JsonValue | undefined): HotelPolicies => (value && typeof value === 'object' && !Array.isArray(value) ? (value as HotelPolicies) : {})
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
const dec = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(6).replace(/\.?0+$/, '') || '0')

/**
 * Hotel Setup (ADR 0021): descriptive and operational hotel content with optimistic concurrency, idempotent saves, audit with the
 * server request id, and a publication gate. Tenant comes from the session; the hotel is always resolved inside that tenant.
 * Setup never touches rates, inventory, mappings or booking state, and publication does not enable any transaction path.
 */
@Injectable()
export class HotelSetupService {
  constructor(private readonly prisma: PrismaService) {}

  private token(hotel: Pick<HotelRow, 'updatedAt'>, profile: Pick<ProfileRow, 'version'> | null): string { return setupToken(hotel, profile) }

  private async load(tx: Tx, tenantId: string, hotelIdRaw: string) {
    const hotelId = idParam('hotelId', hotelIdRaw)
    if (!hotelId) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id: hotelId, tenantId } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    const [profile, identifiers, activeRooms, totalRooms] = await Promise.all([
      tx.hotelProfile.findFirst({ where: { hotelId: hotel.id, tenantId } }),
      tx.hotelExternalIdentifier.findMany({ where: { hotelId: hotel.id, tenantId }, orderBy: { scheme: 'asc' } }),
      tx.roomType.count({ where: { hotelId: hotel.id, isActive: true } }),
      tx.roomType.count({ where: { hotelId: hotel.id } }),
    ])
    return { hotel, profile, identifiers, activeRooms, totalRooms }
  }

  private current(hotel: HotelRow, profile: ProfileRow | null, activeRooms: number): CurrentSetup {
    return {
      name: hotel.name, propertyType: hotel.propertyType, countryCode: hotel.countryCode, city: hotel.city, address: hotel.address, latitude: dec(hotel.latitude), longitude: dec(hotel.longitude), timeZone: hotel.timeZone,
      starRating: hotel.starRating, starVerified: Boolean(profile?.starVerifiedAt), shortDescription: profile?.shortDescription ?? null, checkInTime: profile?.checkInTime ?? null, checkOutTime: profile?.checkOutTime ?? null,
      contacts: asContacts(profile?.contacts), activeRooms,
    }
  }

  private toView(data: Awaited<ReturnType<HotelSetupService['load']>>, includeContacts: boolean): HotelSetupView {
    const { hotel, profile, identifiers, activeRooms, totalRooms } = data
    return {
      generatedAt: new Date().toISOString(), hotelId: hotel.id, concurrencyToken: this.token(hotel, profile), profileExists: profile !== null,
      identity: { name: hotel.name, propertyType: hotel.propertyType, legalName: profile?.legalName ?? null, chainName: profile?.chainName ?? null, brandName: profile?.brandName ?? null, code: hotel.externalRef, externalIdentifiers: identifiers.map((i) => ({ scheme: i.scheme, value: i.value, createdAt: i.createdAt.toISOString() })) },
      location: { countryCode: hotel.countryCode, city: hotel.city, area: profile?.area ?? null, address: hotel.address, postalCode: profile?.postalCode ?? null, latitude: dec(hotel.latitude), longitude: dec(hotel.longitude), timeZone: hotel.timeZone },
      classification: { starRating: hotel.starRating, source: profile?.starSource ?? null, verified: Boolean(profile?.starVerifiedAt), verifiedAt: iso(profile?.starVerifiedAt), verifiedById: profile?.starVerifiedById ?? null },
      content: { shortDescription: profile?.shortDescription ?? null, fullDescription: profile?.fullDescription ?? null, languages: profile?.languages ?? [] },
      operations: { checkInTime: profile?.checkInTime ?? null, checkOutTime: profile?.checkOutTime ?? null, notes: profile?.operationalNotes ?? null },
      contacts: includeContacts ? asContacts(profile?.contacts) : null,
      policies: asPolicies(profile?.policies),
      governance: { status: hotel.contentStatus as HotelProfileStatus, sourceSystem: profile?.sourceSystem ?? null, ownerUserId: profile?.ownerUserId ?? null, approvedById: profile?.approvedById ?? null, approvedAt: iso(profile?.approvedAt), updatedById: profile?.updatedById ?? null, updatedAt: hotel.updatedAt.toISOString() },
      rooms: { active: activeRooms, total: totalRooms },
      completeness: assessCompleteness(this.current(hotel, profile, activeRooms)),
    }
  }

  /** True when the caller's formal roles in this tenant include the key. Used only to decide whether private contacts are returned. */
  async holds(tenantId: string, userId: string, key: string): Promise<boolean> {
    const roles = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({ where: { userId, tenantId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } }))
    return roles.some((a) => a.role.permissions.some((p) => p.permission.key === key))
  }

  async get(tenantId: string, hotelId: string, includeContacts: boolean): Promise<HotelSetupView> {
    return guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => this.toView(await this.load(tx, tenantId, hotelId), includeContacts)))
  }

  private key(value: unknown): string {
    if (typeof value !== 'string' || !KEY.test(value)) throw new BadRequestException('idempotencyKey is required (8-80 letters, digits or . _ : -)')
    return value
  }

  private async replayed(tx: Tx, tenantId: string, hotelId: string, action: string, key: string): Promise<{ requestId: string | null } | null> {
    const found = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'hotel', entityId: hotelId, action, payload: { path: ['idempotencyKey'], equals: key } }, select: { payload: true } })
    if (!found) return null
    const requestId = (found.payload as { requestId?: string | null } | null)?.requestId ?? null
    return { requestId }
  }

  private stale(): never {
    throw new ConflictException({ message: 'This hotel changed after you loaded it. Reload to see the latest version, then re-apply your change.', code: 'HOTEL_SETUP_STALE' })
  }

  async save(tenantId: string, userId: string, hotelId: string, body: HotelSetupSave, requestId: string | null): Promise<HotelSetupSaved> {
    const key = this.key(body?.idempotencyKey)
    if (typeof body.expectedToken !== 'string' || !body.expectedToken) throw new BadRequestException('expectedToken is required')
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined
    const { data, errors } = normaliseSave(body)
    if (errors.length) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    if (data.changed.length === 0) throw new BadRequestException('Nothing to save: no field was supplied')
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const before = await this.load(tx, tenantId, hotelId)
        const again = await this.replayed(tx, tenantId, before.hotel.id, SAVED, key)
        if (again) return { setup: this.toView(before, true), auditRequestId: again.requestId ?? '', replayed: true }
        if (body.expectedToken !== this.token(before.hotel, before.profile)) this.stale()

        const beforeCurrent = this.current(before.hotel, before.profile, before.activeRooms)
        const afterCurrent: CurrentSetup = {
          ...beforeCurrent, ...data.hotel,
          starVerified: data.hotel.starRating !== undefined && data.hotel.starRating !== beforeCurrent.starRating ? false : (data.starVerified ?? beforeCurrent.starVerified),
          shortDescription: data.profile.shortDescription !== undefined ? data.profile.shortDescription : beforeCurrent.shortDescription,
          checkInTime: data.profile.checkInTime !== undefined ? data.profile.checkInTime : beforeCurrent.checkInTime,
          checkOutTime: data.profile.checkOutTime !== undefined ? data.profile.checkOutTime : beforeCurrent.checkOutTime,
          contacts: data.profile.contacts ?? beforeCurrent.contacts,
        }
        if ((afterCurrent.latitude === null) !== (afterCurrent.longitude === null)) throw new BadRequestException({ message: ['latitude and longitude: set or clear both together'], error: 'Bad Request' })
        if (before.hotel.contentStatus === 'COMPLETE') {
          const lost = regressions(assessCompleteness(beforeCurrent), assessCompleteness(afterCurrent))
          if (lost.length) throw new UnprocessableEntityException({ message: `A published hotel cannot lose a publication requirement: ${lost.map((r) => r.label).join('; ')}. Change the hotel status first.`, code: 'HOTEL_PUBLICATION_REQUIREMENT_LOST' })
        }
        if (data.profile.ownerUserId) {
          const member = await tx.membership.findUnique({ where: { userId_tenantId: { userId: data.profile.ownerUserId, tenantId } }, select: { id: true } })
          if (!member) throw new BadRequestException({ message: ['ownerUserId: must be a member of this tenant'], error: 'Bad Request' })
        }

        const now = new Date()
        const starChanged = data.hotel.starRating !== undefined && data.hotel.starRating !== before.hotel.starRating
        const verification = starChanged && data.starVerified === undefined ? { starVerifiedAt: null, starVerifiedById: null }
          : data.starVerified === true ? { starVerifiedAt: now, starVerifiedById: userId }
          : data.starVerified === false ? { starVerifiedAt: null, starVerifiedById: null } : {}
        if (data.starVerified === true && (data.hotel.starRating !== undefined ? data.hotel.starRating : before.hotel.starRating) === null) throw new BadRequestException({ message: ['starVerified: record a star category before verifying it'], error: 'Bad Request' })

        await tx.hotel.update({ where: { id: before.hotel.id }, data: { ...data.hotel, latitude: data.hotel.latitude === undefined ? undefined : data.hotel.latitude === null ? null : new Prisma.Decimal(data.hotel.latitude), longitude: data.hotel.longitude === undefined ? undefined : data.hotel.longitude === null ? null : new Prisma.Decimal(data.hotel.longitude), updatedAt: now } })
        const profileData = { ...data.profile, ...verification, contacts: data.profile.contacts as Prisma.InputJsonValue | undefined, policies: data.profile.policies as Prisma.InputJsonValue | undefined, updatedById: userId }
        if (before.profile) await tx.hotelProfile.update({ where: { id: before.profile.id }, data: { ...profileData, version: { increment: 1 } } })
        else await tx.hotelProfile.create({ data: { ...profileData, tenantId, hotelId: before.hotel.id, version: 1 } })

        if (data.externalIdentifiers) {
          const wanted = new Map(data.externalIdentifiers.map((e) => [e.scheme, e.value]))
          for (const existing of before.identifiers) {
            if (!wanted.has(existing.scheme)) await tx.hotelExternalIdentifier.delete({ where: { id: existing.id } })
            else if (wanted.get(existing.scheme) !== existing.value) { await tx.hotelExternalIdentifier.delete({ where: { id: existing.id } }); await tx.hotelExternalIdentifier.create({ data: { tenantId, hotelId: before.hotel.id, scheme: existing.scheme, value: wanted.get(existing.scheme)!, createdById: userId } }) }
          }
          for (const [scheme, value] of wanted) if (!before.identifiers.some((e) => e.scheme === scheme)) await tx.hotelExternalIdentifier.create({ data: { tenantId, hotelId: before.hotel.id, scheme, value, createdById: userId } })
        }

        // Audit holds field names and non-private before/after values only: never contacts, descriptions, notes or identifiers' values.
        const SAFE = ['name', 'propertyType', 'countryCode', 'city', 'timeZone', 'starRating'] as const
        const changes = Object.fromEntries(SAFE.filter((f) => (data.hotel as Record<string, unknown>)[f] !== undefined && (data.hotel as Record<string, unknown>)[f] !== (before.hotel as Record<string, unknown>)[f]).map((f) => [f, { from: (before.hotel as Record<string, unknown>)[f] ?? null, to: (data.hotel as Record<string, unknown>)[f] ?? null }]))
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: SAVED, entityType: 'hotel', entityId: before.hotel.id, payload: { outcome: 'allowed', requestId, idempotencyKey: key, reason: reason ?? null, fromVersion: before.profile?.version ?? 0, toVersion: (before.profile?.version ?? 0) + 1, fields: data.changed, changes } as Prisma.InputJsonValue } })
        return { setup: this.toView(await this.load(tx, tenantId, hotelId), true), auditRequestId: requestId ?? '', replayed: false }
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        const target = String((error as { meta?: { target?: unknown } }).meta?.target ?? '')
        if (/scheme/.test(target) && /value/.test(target)) throw new ConflictException({ message: 'An external identifier is already assigned to another hotel in this tenant.', code: 'EXTERNAL_IDENTIFIER_CONFLICT' })
        this.stale()
      }
      throw error
    }
  }

  async changeStatus(tenantId: string, userId: string, hotelId: string, body: HotelSetupStatusChange, requestId: string | null): Promise<HotelSetupSaved> {
    const key = this.key(body?.idempotencyKey)
    if (typeof body.expectedToken !== 'string' || !body.expectedToken) throw new BadRequestException('expectedToken is required')
    if (!(HOTEL_PROFILE_STATUSES as readonly string[]).includes(body.to)) throw new BadRequestException('to must be DRAFT, INCOMPLETE, COMPLETE or SUSPENDED')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 3 || reason.length > 500) throw new BadRequestException('A reason of 3 to 500 characters is required')
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const before = await this.load(tx, tenantId, hotelId)
        const again = await this.replayed(tx, tenantId, before.hotel.id, STATUS_CHANGED, key)
        if (again) return { setup: this.toView(before, true), auditRequestId: again.requestId ?? '', replayed: true }
        if (body.expectedToken !== this.token(before.hotel, before.profile)) this.stale()
        if (before.hotel.contentStatus === body.to) throw new ConflictException('The hotel already has this status')
        if (body.to === 'COMPLETE') {
          const c = assessCompleteness(this.current(before.hotel, before.profile, before.activeRooms))
          if (!c.publishable) throw new UnprocessableEntityException({ message: `Cannot publish: ${c.requirements.filter((r) => !r.met).map((r) => r.label).join('; ')}.`, code: 'HOTEL_PUBLICATION_REQUIREMENTS_UNMET' })
        }
        const now = new Date()
        await tx.hotel.update({ where: { id: before.hotel.id }, data: { contentStatus: body.to, updatedAt: now } })
        const approval = body.to === 'COMPLETE' ? { approvedById: userId, approvedAt: now } : { approvedById: null, approvedAt: null }
        if (before.profile) await tx.hotelProfile.update({ where: { id: before.profile.id }, data: { ...approval, updatedById: userId, version: { increment: 1 } } })
        else await tx.hotelProfile.create({ data: { ...approval, tenantId, hotelId: before.hotel.id, updatedById: userId, version: 1 } })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: STATUS_CHANGED, entityType: 'hotel', entityId: before.hotel.id, payload: { outcome: 'allowed', requestId, idempotencyKey: key, reason, from: before.hotel.contentStatus, to: body.to, fromVersion: before.profile?.version ?? 0, toVersion: (before.profile?.version ?? 0) + 1 } as Prisma.InputJsonValue } })
        return { setup: this.toView(await this.load(tx, tenantId, hotelId), true), auditRequestId: requestId ?? '', replayed: false }
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') this.stale()
      throw error
    }
  }
}
