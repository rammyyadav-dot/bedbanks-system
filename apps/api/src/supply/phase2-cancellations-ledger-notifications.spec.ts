import { BadRequestException, ConflictException } from '@nestjs/common'
import {
  assertApprovedSecretReference,
  evaluateBedbankCancellationExecution,
  normalizeConnectorInventoryPayload,
} from './bedbank-connector.adapter'
import { CancellationNotificationService } from './cancellation-notification.service'
import { LedgerService } from '../agent/ledger.service'

describe('Phase 2: Supplier GDS Adapters, Wallet/Ledger Adjustments & Voucher Notifications', () => {
  describe('Bedbank XML/JSON Inventory & Secret Adapter Boundary', () => {
    it('normalizes OTA-style XML_IN inventory pushes into integer minor-unit rows', () => {
      const xml = `
        <InventoryPush>
          <InventoryItem>
            <HotelCode>DXB-ATL-01</HotelCode>
            <RoomCode>DLX-KING</RoomCode>
            <RatePlanCode>RP-FLEX</RatePlanCode>
            <StayDate>2026-12-20</StayDate>
            <Occupancy>2</Occupancy>
            <Allotment>6</Allotment>
            <StopSell>false</StopSell>
            <MinStay>2</MinStay>
            <AmountMinor>89000</AmountMinor>
            <AmountBasis>SELL</AmountBasis>
            <Currency>AED</Currency>
          </InventoryItem>
        </InventoryPush>
      `
      const result = normalizeConnectorInventoryPayload('XML_IN', xml)
      expect(result).toEqual({
        status: 'normalized',
        items: [
          {
            supplierHotelId: 'DXB-ATL-01',
            supplierRoomId: 'DLX-KING',
            ratePlanCode: 'RP-FLEX',
            stayDate: '2026-12-20',
            occupancy: 2,
            allotment: 6,
            stopSell: false,
            minStay: 2,
            amountMinor: 89000n,
            amountBasis: 'SELL',
            currency: 'AED',
          },
        ],
      })
    })

    it('rejects floating-point amounts and unverified rate basis in JSON inventory pushes', () => {
      const rejected = normalizeConnectorInventoryPayload('API_JSON', {
        items: [
          {
            supplierHotelId: 'DXB-01',
            supplierRoomId: 'RM-01',
            ratePlanCode: 'RP-01',
            stayDate: '2026-12-20',
            occupancy: 2,
            allotment: 4,
            amountMinor: '299.50',
            amountBasis: 'SELL',
            currency: 'AED',
          },
        ],
      })
      expect(rejected).toEqual({
        status: 'rejected',
        errors: ['ITEM_0_NON_INTEGER_MINOR_AMOUNT'],
      })
    })

    it('accepts only secret:// references and rejects raw credentials', () => {
      expect(() => assertApprovedSecretReference('secret://vault/fbeds/darina-prod')).not.toThrow()
      expect(() => assertApprovedSecretReference('Bearer sk_live_12345')).toThrow(BadRequestException)
      expect(() => assertApprovedSecretReference('https://example.com/password=123')).toThrow(BadRequestException)
    })

    it('routes supplier timeout to UNKNOWN and supplier penalty discrepancy to MANUAL_REVIEW', () => {
      const timeout = evaluateBedbankCancellationExecution({
        bookingReference: 'FB-DXB-100',
        expectedCustomerLiabilityMinor: 25000n,
        simulatedOutcome: 'timeout',
      })
      expect(timeout).toMatchObject({
        executionStatus: 'UNKNOWN',
        supplierCancellationRef: null,
        discrepancyReviewRequired: false,
      })

      const discrepancy = evaluateBedbankCancellationExecution({
        bookingReference: 'FB-DXB-100',
        expectedCustomerLiabilityMinor: 25000n,
        simulatedOutcome: 'confirmed',
        simulatedSupplierPenaltyMinor: 40000n,
      })
      expect(discrepancy).toMatchObject({
        executionStatus: 'MANUAL_REVIEW',
        discrepancyReviewRequired: true,
        errorClassification: 'SUPPLIER_PENALTY_EXCEEDS_ACCEPTED_TERMS',
      })
    })
  })

  describe('B2B Agency Wallet & Ledger Refund Adjustments', () => {
    const setupLedger = (overrides: { creditLimit?: bigint; priorBalance?: bigint; priorRefundSum?: bigint } = {}) => {
      const wallet = {
        id: 'wal_aed_1',
        tenantId: 'ten_1',
        currency: 'AED',
        creditLimit: overrides.creditLimit ?? 500000n,
        cachedBalance: overrides.priorBalance ?? -100000n,
      }
      const createdEntry = {
        id: 'le_refund_1',
        tenantId: 'ten_1',
        walletId: 'wal_aed_1',
        currency: 'AED',
        amountMinor: 75000n,
        type: 'REFUND',
        idempotencyKey: 'cx-refund-001',
        reference: 'booking:bk_1',
        immutableAt: new Date('2026-11-01T00:00:00.000Z'),
      }
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'wal_aed_1' }]),
        wallet: {
          findFirst: jest.fn().mockResolvedValue(wallet),
          update: jest.fn().mockResolvedValue(wallet),
        },
        ledgerEntry: {
          findUnique: jest.fn().mockResolvedValue(null),
          aggregate: jest.fn()
            .mockResolvedValueOnce({ _sum: { amountMinor: overrides.priorRefundSum ?? 0n } })
            .mockResolvedValueOnce({ _sum: { amountMinor: overrides.priorBalance ?? -100000n } }),
          create: jest.fn().mockResolvedValue(createdEntry),
        },
        auditEvent: {
          create: jest.fn().mockResolvedValue({ id: 'aud_1' }),
        },
      }
      const prisma = { withTenant: jest.fn(async (_t: string, fn: any) => fn(tx)) }
      return { service: new LedgerService(prisma as any), tx }
    }

    it('restores B2B agency available credit on cancellation refund and updates cachedBalance', async () => {
      const { service, tx } = setupLedger({ creditLimit: 500000n, priorBalance: -100000n, priorRefundSum: 0n })
      const result = await service.postB2BLedgerAdjustment({
        tenantId: 'ten_1',
        userId: 'usr_1',
        requestId: 'req_1',
        walletId: 'wal_aed_1',
        currency: 'AED',
        type: 'REFUND',
        amountMinor: 75000n,
        authorizedRefundableMinor: 100000n,
        reference: 'booking:bk_1',
        idempotencyKey: 'cx-refund-001',
      })
      expect(result).toMatchObject({
        walletId: 'wal_aed_1',
        durableBalanceMinor: -25000n,
        creditLimitMinor: 500000n,
        availableCreditMinor: 475000n,
      })
      expect(tx.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wal_aed_1', tenantId: 'ten_1' },
        data: { cachedBalance: -25000n },
      })
      expect(tx.auditEvent.create).toHaveBeenCalledTimes(1)
      expect(tx.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'finance.ledger.adjustment_posted',
          payload: expect.objectContaining({ outcome: 'allowed', balanceBeforeMinor: '-100000', balanceAfterMinor: '-25000', amountMinor: '75000', reference: 'booking:bk_1' }),
        }),
      }))
    })

    it('blocks excess refund when prior partial refunds plus new refund exceed authorized refundable amount', async () => {
      const { service, tx } = setupLedger({ priorRefundSum: 40000n })
      await expect(
        service.postB2BLedgerAdjustment({
          tenantId: 'ten_1',
          userId: 'usr_1',
          walletId: 'wal_aed_1',
          currency: 'AED',
          type: 'REFUND',
          amountMinor: 70000n,
          authorizedRefundableMinor: 100000n,
          reference: 'booking:bk_1',
          idempotencyKey: 'cx-refund-excess',
        }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(tx.ledgerEntry.create).not.toHaveBeenCalled()
      expect(tx.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'finance.ledger.adjustment_denied', entityId: 'wal_aed_1', payload: expect.objectContaining({ outcome: 'denied', code: 'REFUND_EXCEEDS_AUTHORIZED' }) }),
      }))
    })

    it('audits a refund that on its own exceeds the authorized amount and posts nothing', async () => {
      const { service, tx } = setupLedger()
      await expect(service.postB2BLedgerAdjustment({
        tenantId: 'ten_1', userId: 'usr_1', walletId: 'wal_aed_1', currency: 'AED', type: 'REFUND', amountMinor: 150000n, authorizedRefundableMinor: 100000n, reference: 'booking:bk_1', idempotencyKey: 'cx-refund-over',
      })).rejects.toBeInstanceOf(BadRequestException)
      expect(tx.ledgerEntry.create).not.toHaveBeenCalled()
      expect(tx.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'finance.ledger.adjustment_denied', payload: expect.objectContaining({ code: 'REFUND_EXCEEDS_AUTHORIZED', amountMinor: '150000' }) }),
      }))
    })

    it('records a replay of the same refund and does not post again', async () => {
      const { service, tx } = setupLedger()
      tx.ledgerEntry.findUnique.mockResolvedValue({
        id: 'le_refund_1', tenantId: 'ten_1', walletId: 'wal_aed_1', currency: 'AED', amountMinor: 75000n, type: 'REFUND', idempotencyKey: 'cx-refund-001', reference: 'booking:bk_1',
      })
      tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinor: -25000n } })
      const result = await service.postB2BLedgerAdjustment({
        tenantId: 'ten_1', userId: 'usr_1', walletId: 'wal_aed_1', currency: 'AED', type: 'REFUND', amountMinor: 75000n, authorizedRefundableMinor: 100000n, reference: 'booking:bk_1', idempotencyKey: 'cx-refund-001',
      })
      expect(result.entry.id).toBe('le_refund_1')
      expect(tx.ledgerEntry.create).not.toHaveBeenCalled()
      expect(tx.wallet.update).not.toHaveBeenCalled()
      expect(tx.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ action: 'finance.ledger.adjustment_replayed', entityId: 'le_refund_1', payload: expect.objectContaining({ outcome: 'replayed' }) }),
      }))
    })
  })

  describe('Automated Cancellation Voucher Notification Workflows', () => {
    it('dispatches CLIENT_EMAIL and SUPPLIER_WEBHOOK vouchers idempotently and rejects conflicting key reuse', async () => {
      const storedEvents: any[] = []
      const tx = {
        auditEvent: {
          findMany: jest.fn(async () => storedEvents),
          create: jest.fn(async ({ data }: any) => {
            const ev = { id: `ev_${storedEvents.length + 1}`, ...data, createdAt: new Date('2026-11-01T00:00:00.000Z') }
            storedEvents.push(ev)
            return ev
          }),
        },
      }
      const prisma = { withTenant: jest.fn(async (_t: string, fn: any) => fn(tx)) }
      const notifications = new CancellationNotificationService(prisma as any)

      const first = await notifications.dispatch({
        tenantId: 'ten_1',
        userId: 'usr_1',
        bookingId: 'bk_1',
        bookingReference: 'FB-DXB-100',
        supplierCancellationRef: 'CX-FB-DXB-100',
        channels: ['CLIENT_EMAIL', 'SUPPLIER_WEBHOOK'],
        currency: 'AED',
        penaltyMinor: 25000n,
        refundMinor: 75000n,
        idempotencyKey: 'voucher-key-1',
      })
      expect(first).toHaveLength(2)
      expect(first.map((d) => d.channel)).toEqual(['CLIENT_EMAIL', 'SUPPLIER_WEBHOOK'])

      // Idempotent retry returns same 2 deliveries without creating new audit events
      const retry = await notifications.dispatch({
        tenantId: 'ten_1',
        userId: 'usr_1',
        bookingId: 'bk_1',
        bookingReference: 'FB-DXB-100',
        supplierCancellationRef: 'CX-FB-DXB-100',
        channels: ['CLIENT_EMAIL', 'SUPPLIER_WEBHOOK'],
        currency: 'AED',
        penaltyMinor: 25000n,
        refundMinor: 75000n,
        idempotencyKey: 'voucher-key-1',
      })
      expect(retry).toHaveLength(2)
      expect(tx.auditEvent.create).toHaveBeenCalledTimes(2)

      // Conflicting reuse with different refundMinor throws ConflictException
      await expect(
        notifications.dispatch({
          tenantId: 'ten_1',
          userId: 'usr_1',
          bookingId: 'bk_1',
          bookingReference: 'FB-DXB-100',
          supplierCancellationRef: 'CX-FB-DXB-100',
          channels: ['CLIENT_EMAIL'],
          currency: 'AED',
          penaltyMinor: 25000n,
          refundMinor: 90000n,
          idempotencyKey: 'voucher-key-1',
        }),
      ).rejects.toBeInstanceOf(ConflictException)
    })
  })
})
