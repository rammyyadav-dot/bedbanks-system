import { Inject, Injectable } from '@nestjs/common'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'
import type { OfferHoldRequest, OfferHoldResponse } from '@bedbanks/domain'
import { AgentAuditService } from './audit.service'
import { InventoryHoldService } from './inventory-hold.service'
import { SUPPLIER_ADAPTER, SupplierAdapter, SupplierProviderError, type RecheckedOfferAuthority, type SupplierRecheckResult } from './supplier.port'
import { assertSupportedSettlementCurrency } from './currency'

const RECHECK_TIMEOUT_MS = 5_000
const safeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0

@Injectable()
export class OfferHoldService {
  constructor(
    @Inject(SUPPLIER_ADAPTER) private readonly supplier: SupplierAdapter,
    private readonly prisma: PrismaService,
    private readonly holds: InventoryHoldService,
    private readonly audit: AgentAuditService,
  ) {}

  async recheck(command: Omit<OfferHoldRequest, 'idempotencyKey'> & { tenantId: string; user: AuthenticatedUser; requestId: string }): Promise<OfferHoldResponse> {
    return this.evaluate(command, false)
  }

  async execute(command: (OfferHoldRequest | Omit<OfferHoldRequest, 'idempotencyKey'>) & { tenantId: string; user: AuthenticatedUser; requestId: string }): Promise<OfferHoldResponse> {
    return this.evaluate(command, true)
  }

  private async evaluate(command: (OfferHoldRequest | Omit<OfferHoldRequest, 'idempotencyKey'>) & { tenantId: string; user: AuthenticatedUser; requestId: string }, createHold: boolean): Promise<OfferHoldResponse> {
    const startedAt = Date.now()
    const base = { offerId: command.offerId, searchId: command.searchId, requestId: command.requestId }
    if (this.supplier.name === 'unconfigured') return this.outcome(command, { ...base, status: 'provider_unavailable' }, 'unconfigured', Date.now() - startedAt)
    let result: SupplierRecheckResult
    try {
      result = await this.withTimeout(this.supplier.recheck(
        { offerId: command.offerId, searchId: command.searchId },
        { tenantId: command.tenantId, userId: command.user.user.id, requestId: command.requestId },
      ))
    } catch (error) {
      const reason = error instanceof SupplierProviderError ? error.code : 'transport'
      return this.outcome(command, { ...base, status: 'provider_unavailable' }, reason, Date.now() - startedAt)
    }
    if (result.status !== 'available') return this.outcome(command, { ...base, status: result.status }, result.status, Date.now() - startedAt)
    const offer = result.offer
    const malformed = this.validateAuthority(offer, command)
    if (malformed) return this.outcome(command, { ...base, status: malformed }, malformed, Date.now() - startedAt)
    let mapped = false
    try { mapped = await this.verifyMapping(command.tenantId, offer) } catch { mapped = false }
    if (!mapped) return this.outcome(command, { ...base, status: 'mapping_invalid' }, 'mapping_invalid', Date.now() - startedAt)
    if (offer.currency !== command.expectedCurrency || offer.sellAmountMinor !== command.expectedSellAmountMinor) {
      return this.outcome(command, { ...base, status: 'price_changed', currency: offer.currency, sellAmountMinor: offer.sellAmountMinor, expiresAt: offer.expiresAt }, 'price_changed', Date.now() - startedAt)
    }
    if (!createHold) {
      return this.outcome(command, { ...base, status: 'held', currency: offer.currency, sellAmountMinor: offer.sellAmountMinor, expiresAt: offer.expiresAt }, 'rechecked', Date.now() - startedAt)
    }
    if (!('idempotencyKey' in command)) return this.outcome(command, { ...base, status: 'rejected' }, 'missing_idempotency_key', Date.now() - startedAt)
    try {
      const held = await this.holds.create({
        tenantId: command.tenantId, userId: command.user.user.id, requestId: command.requestId,
        offerId: offer.offerId, searchId: offer.searchId, ratePlanId: offer.ratePlanId,
        canonicalHotelId: offer.canonicalHotelId, canonicalRoomTypeId: offer.canonicalRoomTypeId,
        boardBasisId: offer.boardBasisId, checkIn: offer.checkIn, checkOut: offer.checkOut,
        rooms: offer.rooms, currency: offer.currency, sellAmountMinor: offer.sellAmountMinor,
        offerExpiresAt: offer.expiresAt, idempotencyKey: command.idempotencyKey,
      })
      const response: OfferHoldResponse = { ...base, status: 'held', holdId: held.holdId, currency: held.currency,
        sellAmountMinor: held.sellAmountMinor, expiresAt: held.expiresAt }
      await this.record(command, response.status, held.status, Date.now() - startedAt)
      return response
    } catch {
      return this.outcome(command, { ...base, status: 'unavailable' }, 'inventory_unavailable', Date.now() - startedAt)
    }
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([work, new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new SupplierProviderError('timeout')), RECHECK_TIMEOUT_MS)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }

  private validateAuthority(offer: RecheckedOfferAuthority, command: OfferHoldRequest): 'rejected' | 'offer_expired' | undefined {
    const ids = [offer.offerId, offer.searchId, offer.supplierId, offer.supplierHotelId, offer.supplierRoomId,
      offer.canonicalHotelId, offer.canonicalRoomTypeId, offer.ratePlanId, offer.boardBasisId]
    if (ids.some(value => typeof value !== 'string' || !value || value.trim() !== value) ||
      offer.offerId !== command.offerId || offer.searchId !== command.searchId || !safeInteger(offer.sellAmountMinor) ||
      !Number.isSafeInteger(offer.rooms) || offer.rooms < 1 || offer.rooms > 8 || !Number.isSafeInteger(offer.adults) || offer.adults < 1 ||
      !Number.isSafeInteger(offer.children) || offer.children < 0 || !Array.isArray(offer.childAges) || offer.childAges.length !== offer.children ||
      offer.childAges.some(age => !Number.isSafeInteger(age) || age < 0 || age > 17)) return 'rejected'
    try { assertSupportedSettlementCurrency(offer.currency) } catch { return 'rejected' }
    if (!Number.isFinite(Date.parse(offer.expiresAt)) || Date.parse(offer.expiresAt) <= Date.now()) return 'offer_expired'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(offer.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(offer.checkOut) || offer.checkOut <= offer.checkIn) return 'rejected'
    return undefined
  }

  private verifyMapping(tenantId: string, offer: RecheckedOfferAuthority): Promise<boolean> {
    const today = new Date(); const checkIn = new Date(`${offer.checkIn}T00:00:00.000Z`); const checkOut = new Date(`${offer.checkOut}T00:00:00.000Z`)
    return this.prisma.withTenant(tenantId, async tx => {
      const plan = await tx.ratePlan.findFirst({ where: {
        id: offer.ratePlanId, tenantId, status: 'ACTIVE', boardBasisId: offer.boardBasisId,
        roomTypeId: offer.canonicalRoomTypeId, currency: offer.currency,
        occupancy: { gte: offer.adults + offer.children }, boardBasis: { isActive: true },
        roomType: { isActive: true, hotelId: offer.canonicalHotelId, maxAdults: { gte: offer.adults }, maxChildren: { gte: offer.children }, maxOccupancy: { gte: offer.adults + offer.children }, hotel: { tenantId, contentStatus: 'COMPLETE' } },
        contract: { tenantId, supplierId: offer.supplierId, status: 'ACTIVE', validFrom: { lte: checkIn }, validTo: { gte: checkOut }, settlementCurrency: offer.currency,
          supplier: { tenantId, status: 'ACTIVE' }, supplierHotelMapping: { tenantId, hotelId: offer.canonicalHotelId, supplierHotelId: offer.supplierHotelId, status: 'MAPPED',
            roomMappings: { some: { tenantId, supplierRoomId: offer.supplierRoomId, roomTypeId: offer.canonicalRoomTypeId, status: 'MAPPED' } } } },
      }, select: { id: true, minStay: true, maxStay: true, releaseDays: true } })
      if (!plan) return false
      const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000)
      const leadDays = Math.floor((checkIn.getTime() - today.getTime()) / 86_400_000)
      return nights >= plan.minStay && (plan.maxStay === null || nights <= plan.maxStay) && leadDays >= plan.releaseDays
    })
  }

  private async outcome(command: (OfferHoldRequest | Omit<OfferHoldRequest, 'idempotencyKey'>) & { tenantId: string; user: AuthenticatedUser; requestId: string }, response: OfferHoldResponse, reason: string, durationMs: number) {
    await this.record(command, response.status, reason, durationMs)
    return response
  }

  private record(command: (OfferHoldRequest | Omit<OfferHoldRequest, 'idempotencyKey'>) & { tenantId: string; user: AuthenticatedUser; requestId: string }, status: string, reason: string, durationMs: number) {
    return this.audit.record({ tenantId: command.tenantId, user: command.user, action: `offer.recheck.${status}`,
      entityType: 'offer', entityId: command.offerId, payload: { requestId: command.requestId, searchId: command.searchId, provider: this.supplier.name, reason, durationMs } })
  }
}
