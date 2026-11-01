import { BadRequestException } from '@nestjs/common'
import type {
  ConnectorFormatType,
  SupplierCancellationOutcomeStatus,
} from '@bedbanks/contracts'

export interface NormalizedInventoryItem {
  supplierHotelId: string
  supplierRoomId: string
  ratePlanCode: string
  stayDate: string
  occupancy: number
  allotment: number
  stopSell: boolean
  minStay: number
  amountMinor: bigint
  amountBasis: 'NET' | 'SELL'
  currency: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_CODE = /^[A-Z]{3}$/
const MINOR_INT = /^\d+$/

function extractXmlTag(block: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i')
  const match = regex.exec(block)
  return match ? match[1].trim() : undefined
}

export function normalizeConnectorInventoryPayload(
  format: ConnectorFormatType,
  payload: unknown,
): { status: 'normalized'; items: NormalizedInventoryItem[] } | { status: 'rejected'; errors: string[] } {
  const errors: string[] = []
  const items: NormalizedInventoryItem[] = []

  if (format === 'XML_IN' || format === 'XML_OUT') {
    if (typeof payload !== 'string' || !payload.trim().startsWith('<')) {
      return { status: 'rejected', errors: ['XML_PAYLOAD_REQUIRED'] }
    }
    const matches = Array.from(payload.matchAll(/<InventoryItem>([\s\S]*?)<\/InventoryItem>/gi))
    if (!matches.length) return { status: 'rejected', errors: ['XML_NO_INVENTORY_ITEMS'] }

    matches.forEach((m, index) => {
      const block = m[1]
      const check = validateRow(
        {
          supplierHotelId: extractXmlTag(block, 'HotelCode') ?? '',
          supplierRoomId: extractXmlTag(block, 'RoomCode') ?? '',
          ratePlanCode: extractXmlTag(block, 'RatePlanCode') ?? '',
          stayDate: extractXmlTag(block, 'StayDate') ?? '',
          occupancy: Number(extractXmlTag(block, 'Occupancy') ?? ''),
          allotment: Number(extractXmlTag(block, 'Allotment') ?? ''),
          stopSell: ['true', '1'].includes((extractXmlTag(block, 'StopSell') ?? 'false').toLowerCase()),
          minStay: Number(extractXmlTag(block, 'MinStay') ?? '1'),
          amountMinorRaw: extractXmlTag(block, 'AmountMinor') ?? '',
          amountBasis: (extractXmlTag(block, 'AmountBasis') ?? '').toUpperCase(),
          currency: (extractXmlTag(block, 'Currency') ?? '').toUpperCase(),
        },
        index,
      )
      if (check.error) errors.push(check.error)
      else if (check.item) items.push(check.item)
    })

    return errors.length ? { status: 'rejected', errors } : { status: 'normalized', items }
  }

  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { items?: unknown }).items)) {
    return { status: 'rejected', errors: ['JSON_ITEMS_ARRAY_REQUIRED'] }
  }
  const rawItems = (payload as { items: Array<Record<string, unknown>> }).items
  if (!rawItems.length) return { status: 'rejected', errors: ['JSON_NO_INVENTORY_ITEMS'] }

  rawItems.forEach((raw, index) => {
    const check = validateRow(
      {
        supplierHotelId: typeof raw.supplierHotelId === 'string' ? raw.supplierHotelId.trim() : '',
        supplierRoomId: typeof raw.supplierRoomId === 'string' ? raw.supplierRoomId.trim() : '',
        ratePlanCode: typeof raw.ratePlanCode === 'string' ? raw.ratePlanCode.trim() : '',
        stayDate: typeof raw.stayDate === 'string' ? raw.stayDate.trim() : '',
        occupancy: typeof raw.occupancy === 'number' ? raw.occupancy : Number.NaN,
        allotment: typeof raw.allotment === 'number' ? raw.allotment : Number.NaN,
        stopSell: Boolean(raw.stopSell),
        minStay: raw.minStay === undefined ? 1 : Number(raw.minStay),
        amountMinorRaw: typeof raw.amountMinor === 'string' ? raw.amountMinor.trim() : String(raw.amountMinor ?? ''),
        amountBasis: typeof raw.amountBasis === 'string' ? raw.amountBasis.toUpperCase() : '',
        currency: typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '',
      },
      index,
    )
    if (check.error) errors.push(check.error)
    else if (check.item) items.push(check.item)
  })

  return errors.length ? { status: 'rejected', errors } : { status: 'normalized', items }
}

function validateRow(
  raw: {
    supplierHotelId: string
    supplierRoomId: string
    ratePlanCode: string
    stayDate: string
    occupancy: number
    allotment: number
    stopSell: boolean
    minStay: number
    amountMinorRaw: string
    amountBasis: string
    currency: string
  },
  index: number,
): { item?: NormalizedInventoryItem; error?: string } {
  if (!raw.supplierHotelId || !raw.supplierRoomId || !raw.ratePlanCode) return { error: `ITEM_${index}_MISSING_MAPPING_CODES` }
  if (!ISO_DATE.test(raw.stayDate)) return { error: `ITEM_${index}_INVALID_STAY_DATE` }
  if (!Number.isInteger(raw.occupancy) || raw.occupancy < 1) return { error: `ITEM_${index}_INVALID_OCCUPANCY` }
  if (!Number.isInteger(raw.allotment) || raw.allotment < 0) return { error: `ITEM_${index}_INVALID_ALLOTMENT` }
  if (!Number.isInteger(raw.minStay) || raw.minStay < 1) return { error: `ITEM_${index}_INVALID_MIN_STAY` }
  if (!MINOR_INT.test(raw.amountMinorRaw)) return { error: `ITEM_${index}_NON_INTEGER_MINOR_AMOUNT` }
  if (raw.amountBasis !== 'NET' && raw.amountBasis !== 'SELL') return { error: `ITEM_${index}_UNVERIFIED_AMOUNT_BASIS` }
  if (!CURRENCY_CODE.test(raw.currency)) return { error: `ITEM_${index}_INVALID_CURRENCY` }

  return {
    item: {
      supplierHotelId: raw.supplierHotelId,
      supplierRoomId: raw.supplierRoomId,
      ratePlanCode: raw.ratePlanCode,
      stayDate: raw.stayDate,
      occupancy: raw.occupancy,
      allotment: raw.allotment,
      stopSell: raw.stopSell,
      minStay: raw.minStay,
      amountMinor: BigInt(raw.amountMinorRaw),
      amountBasis: raw.amountBasis,
      currency: raw.currency,
    },
  }
}

export function assertApprovedSecretReference(secretRef: string): void {
  const trimmed = secretRef.trim()
  if (!/^secret:\/\/[a-z0-9._/-]+$/i.test(trimmed) || /(password|bearer|sk_live|api_key=)/i.test(trimmed)) {
    throw new BadRequestException('Connector secretRef must be an approved secret:// reference, never raw credentials')
  }
}

export function evaluateBedbankCancellationExecution(input: {
  bookingReference: string
  expectedCustomerLiabilityMinor: bigint
  simulatedOutcome?: 'confirmed' | 'rejected' | 'timeout'
  simulatedSupplierPenaltyMinor?: bigint
}): {
  executionStatus: SupplierCancellationOutcomeStatus
  supplierCancellationRef: string | null
  supplierPenaltyMinor: bigint | null
  discrepancyReviewRequired: boolean
  errorClassification: string | null
} {
  const outcome = input.simulatedOutcome ?? 'confirmed'
  if (outcome === 'timeout') {
    return {
      executionStatus: 'UNKNOWN',
      supplierCancellationRef: null,
      supplierPenaltyMinor: null,
      discrepancyReviewRequired: false,
      errorClassification: 'SUPPLIER_TIMEOUT_RECONCILIATION_REQUIRED',
    }
  }
  if (outcome === 'rejected') {
    return {
      executionStatus: 'REJECTED',
      supplierCancellationRef: null,
      supplierPenaltyMinor: null,
      discrepancyReviewRequired: false,
      errorClassification: 'SUPPLIER_CANCELLATION_REJECTED',
    }
  }

  const supplierPenaltyMinor = input.simulatedSupplierPenaltyMinor ?? input.expectedCustomerLiabilityMinor
  const discrepancyReviewRequired = supplierPenaltyMinor > input.expectedCustomerLiabilityMinor

  return {
    executionStatus: discrepancyReviewRequired ? 'MANUAL_REVIEW' : 'CONFIRMED',
    supplierCancellationRef: `CX-${input.bookingReference}`,
    supplierPenaltyMinor,
    discrepancyReviewRequired,
    errorClassification: discrepancyReviewRequired ? 'SUPPLIER_PENALTY_EXCEEDS_ACCEPTED_TERMS' : null,
  }
}
