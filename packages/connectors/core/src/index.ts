export type ConnectorCapability =
  | 'search'
  | 'recheck'
  | 'prebook'
  | 'book'
  | 'cancel'
  | 'content'
  | 'availability'
  | 'webhook'
  | 'status';

export type ConnectorFormat = 'API_JSON' | 'XML_IN' | 'XML_OUT' | 'CHANNEL_MANAGER' | 'MANUAL_EXTRANET';

export interface ConnectorContext {
  tenantId: string;
  correlationId: string;
  connectorId?: string;
  supplierId?: string;
}

export interface CanonicalInventoryWindowRule {
  daysBeforeCheckin: number;
  penaltyPercent?: number;
  penaltyMinor?: string;
  currency?: string;
}

export interface CanonicalInventoryDeltaRow {
  supplierHotelId: string;
  supplierRoomId: string;
  ratePlanCode: string;
  stayDate: string;
  occupancy: number;
  allotment: number;
  stopSell: boolean;
  minStay: number;
  amountMinor: string;
  amountBasis: 'NET' | 'SELL';
  currency: string;
  cancellationRules?: CanonicalInventoryWindowRule[];
}

export type InventoryNormalizationResult =
  | { status: 'normalized'; format: ConnectorFormat; rows: CanonicalInventoryDeltaRow[]; warnings: string[] }
  | { status: 'rejected'; format: ConnectorFormat; errors: string[] };

export type SupplierCancellationExecutionStatus =
  | 'CONFIRMED'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'MANUAL_REVIEW';

export interface SupplierCancellationExecutionRequest {
  bookingReference: string;
  supplierReference: string;
  correlationId: string;
  idempotencyKey: string;
  currency: string;
  expectedCustomerLiabilityMinor: string;
  requestedAt: string;
}

export interface SupplierCancellationExecutionResult {
  status: SupplierCancellationExecutionStatus;
  correlationId: string;
  supplierCancellationRef: string | null;
  supplierPenaltyMinor: string | null;
  currency: string;
  discrepancyReviewRequired: boolean;
  errorClassification: string | null;
  evaluatedAt: string;
}

export interface ConnectorAdapter {
  readonly provider: string;
  readonly format?: ConnectorFormat;
  readonly capabilities: readonly ConnectorCapability[];
  health(context: ConnectorContext): Promise<'healthy' | 'degraded' | 'unhealthy'>;
  normalizeInventory?(rawPayload: unknown, context: ConnectorContext): InventoryNormalizationResult;
  executeCancellation?(
    request: SupplierCancellationExecutionRequest,
    context: ConnectorContext,
  ): Promise<SupplierCancellationExecutionResult>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MINOR_INT = /^\d+$/;

function extractXmlTag(block: string, tag: string): string | undefined {
  const regex = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i');
  const match = regex.exec(block);
  return match ? match[1].trim() : undefined;
}

/**
 * Normalizes real-time Bedbank/GDS JSON or OTA-style XML inventory & rate pushes
 * into canonical integer minor-unit rows. Rejects floating-point amounts, negative
 * allotments, or missing commercial basis (NET/SELL) fail-closed.
 */
export function normalizeBedbankInventoryPayload(
  format: ConnectorFormat,
  payload: unknown,
): InventoryNormalizationResult {
  const errors: string[] = [];
  const rows: CanonicalInventoryDeltaRow[] = [];

  if (format === 'XML_IN' || format === 'XML_OUT') {
    if (typeof payload !== 'string' || !payload.trim().startsWith('<')) {
      return { status: 'rejected', format, errors: ['XML_PAYLOAD_REQUIRED'] };
    }
    const itemRegex = /<InventoryItem>([\s\S]*?)<\/InventoryItem>/gi;
    const matches = Array.from(payload.matchAll(itemRegex));
    if (!matches.length) {
      return { status: 'rejected', format, errors: ['XML_NO_INVENTORY_ITEMS'] };
    }
    matches.forEach((match, index) => {
      const block = match[1];
      const supplierHotelId = extractXmlTag(block, 'HotelCode') ?? '';
      const supplierRoomId = extractXmlTag(block, 'RoomCode') ?? '';
      const ratePlanCode = extractXmlTag(block, 'RatePlanCode') ?? '';
      const stayDate = extractXmlTag(block, 'StayDate') ?? '';
      const occupancyRaw = extractXmlTag(block, 'Occupancy') ?? '';
      const allotmentRaw = extractXmlTag(block, 'Allotment') ?? '';
      const stopSellRaw = (extractXmlTag(block, 'StopSell') ?? 'false').toLowerCase();
      const minStayRaw = extractXmlTag(block, 'MinStay') ?? '1';
      const amountMinor = extractXmlTag(block, 'AmountMinor') ?? '';
      const amountBasisRaw = (extractXmlTag(block, 'AmountBasis') ?? '').toUpperCase();
      const currency = (extractXmlTag(block, 'Currency') ?? '').toUpperCase();

      const validated = validateCanonicalInventoryRow(
        {
          supplierHotelId,
          supplierRoomId,
          ratePlanCode,
          stayDate,
          occupancy: Number(occupancyRaw),
          allotment: Number(allotmentRaw),
          stopSell: stopSellRaw === 'true' || stopSellRaw === '1',
          minStay: Number(minStayRaw),
          amountMinor,
          amountBasis: amountBasisRaw as 'NET' | 'SELL',
          currency,
        },
        index,
      );
      if (validated.error) errors.push(validated.error);
      else if (validated.row) rows.push(validated.row);
    });

    if (errors.length) return { status: 'rejected', format, errors };
    return { status: 'normalized', format, rows, warnings: [] };
  }

  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as { items?: unknown }).items)) {
    return { status: 'rejected', format, errors: ['JSON_ITEMS_ARRAY_REQUIRED'] };
  }

  const rawItems = (payload as { items: Array<Record<string, unknown>> }).items;
  if (!rawItems.length) {
    return { status: 'rejected', format, errors: ['JSON_NO_INVENTORY_ITEMS'] };
  }

  rawItems.forEach((item, index) => {
    const validated = validateCanonicalInventoryRow(
      {
        supplierHotelId: typeof item.supplierHotelId === 'string' ? item.supplierHotelId.trim() : '',
        supplierRoomId: typeof item.supplierRoomId === 'string' ? item.supplierRoomId.trim() : '',
        ratePlanCode: typeof item.ratePlanCode === 'string' ? item.ratePlanCode.trim() : '',
        stayDate: typeof item.stayDate === 'string' ? item.stayDate.trim() : '',
        occupancy: typeof item.occupancy === 'number' ? item.occupancy : Number.NaN,
        allotment: typeof item.allotment === 'number' ? item.allotment : Number.NaN,
        stopSell: Boolean(item.stopSell),
        minStay: item.minStay === undefined ? 1 : Number(item.minStay),
        amountMinor: typeof item.amountMinor === 'string' ? item.amountMinor.trim() : String(item.amountMinor ?? ''),
        amountBasis: (typeof item.amountBasis === 'string' ? item.amountBasis.toUpperCase() : '') as 'NET' | 'SELL',
        currency: typeof item.currency === 'string' ? item.currency.trim().toUpperCase() : '',
      },
      index,
    );
    if (validated.error) errors.push(validated.error);
    else if (validated.row) rows.push(validated.row);
  });

  if (errors.length) return { status: 'rejected', format, errors };
  return { status: 'normalized', format, rows, warnings: [] };
}

function validateCanonicalInventoryRow(
  candidate: CanonicalInventoryDeltaRow,
  index: number,
): { row?: CanonicalInventoryDeltaRow; error?: string } {
  if (!candidate.supplierHotelId || !candidate.supplierRoomId || !candidate.ratePlanCode) {
    return { error: `ITEM_${index}_MISSING_MAPPING_CODES` };
  }
  if (!ISO_DATE.test(candidate.stayDate)) {
    return { error: `ITEM_${index}_INVALID_STAY_DATE` };
  }
  if (!Number.isInteger(candidate.occupancy) || candidate.occupancy < 1) {
    return { error: `ITEM_${index}_INVALID_OCCUPANCY` };
  }
  if (!Number.isInteger(candidate.allotment) || candidate.allotment < 0) {
    return { error: `ITEM_${index}_INVALID_ALLOTMENT` };
  }
  if (!Number.isInteger(candidate.minStay) || candidate.minStay < 1) {
    return { error: `ITEM_${index}_INVALID_MIN_STAY` };
  }
  if (!MINOR_INT.test(candidate.amountMinor)) {
    return { error: `ITEM_${index}_NON_INTEGER_MINOR_AMOUNT` };
  }
  if (candidate.amountBasis !== 'NET' && candidate.amountBasis !== 'SELL') {
    return { error: `ITEM_${index}_UNVERIFIED_AMOUNT_BASIS` };
  }
  if (!CURRENCY_CODE.test(candidate.currency)) {
    return { error: `ITEM_${index}_INVALID_CURRENCY` };
  }
  return { row: candidate };
}

/**
 * Evaluates a supplier cancellation response according to fBeds bedbank rules:
 * - Timeouts or transport ambiguities yield UNKNOWN (requires status reconciliation, never blind retry).
 * - Supplier penalty exceeding accepted customer liability triggers MANUAL_REVIEW discrepancy protection.
 */
export function evaluateSupplierCancellationOutcome(
  request: SupplierCancellationExecutionRequest,
  supplierResponse:
    | { outcome: 'confirmed'; supplierCancellationRef: string; supplierPenaltyMinor: string; currency: string }
    | { outcome: 'rejected'; errorCode: string }
    | { outcome: 'timeout' | 'transport_error'; errorCode: string },
): SupplierCancellationExecutionResult {
  const evaluatedAt = request.requestedAt;
  if (supplierResponse.outcome === 'rejected') {
    return {
      status: 'REJECTED',
      correlationId: request.correlationId,
      supplierCancellationRef: null,
      supplierPenaltyMinor: null,
      currency: request.currency,
      discrepancyReviewRequired: false,
      errorClassification: supplierResponse.errorCode,
      evaluatedAt,
    };
  }
  if (supplierResponse.outcome !== 'confirmed') {
    return {
      status: 'UNKNOWN',
      correlationId: request.correlationId,
      supplierCancellationRef: null,
      supplierPenaltyMinor: null,
      currency: request.currency,
      discrepancyReviewRequired: false,
      errorClassification: supplierResponse.errorCode,
      evaluatedAt,
    };
  }

  if (
    supplierResponse.currency !== request.currency ||
    !MINOR_INT.test(supplierResponse.supplierPenaltyMinor) ||
    !MINOR_INT.test(request.expectedCustomerLiabilityMinor)
  ) {
    return {
      status: 'MANUAL_REVIEW',
      correlationId: request.correlationId,
      supplierCancellationRef: supplierResponse.supplierCancellationRef,
      supplierPenaltyMinor: supplierResponse.supplierPenaltyMinor,
      currency: supplierResponse.currency,
      discrepancyReviewRequired: true,
      errorClassification: 'CURRENCY_OR_PENALTY_MISMATCH',
      evaluatedAt,
    };
  }

  const supplierPenalty = BigInt(supplierResponse.supplierPenaltyMinor);
  const customerLiability = BigInt(request.expectedCustomerLiabilityMinor);
  const discrepancyReviewRequired = supplierPenalty > customerLiability;

  return {
    status: discrepancyReviewRequired ? 'MANUAL_REVIEW' : 'CONFIRMED',
    correlationId: request.correlationId,
    supplierCancellationRef: supplierResponse.supplierCancellationRef,
    supplierPenaltyMinor: supplierPenalty.toString(),
    currency: request.currency,
    discrepancyReviewRequired,
    errorClassification: discrepancyReviewRequired ? 'SUPPLIER_PENALTY_EXCEEDS_ACCEPTED_TERMS' : null,
    evaluatedAt,
  };
}
export { HotelbedsSandboxTransport, SandboxError, assertHotelbedsBookBody, hotelbedsAedMinor, normalizeHotelbedsResponse, validateSandboxSearch, retryAfter } from './hotelbeds-sandbox';
export type { SandboxContext, SandboxScope, SandboxConfig, HotelbedsObservation, HotelbedsBookBody, HotelbedsBookPax } from './hotelbeds-sandbox';
export { buildHotelbedsBookBody, hotelbedsClientReference, normalizeHotelbedsBooking, findHotelbedsBooking } from './hotelbeds-booking';
export type { HotelbedsBookingInputs, HotelbedsBookingGuest, HotelbedsBookingFacts, HotelbedsBookingState } from './hotelbeds-booking';
export { syncHotelbedsContent } from './hotelbeds-content-sync';
export type { ContentStagingStore, ContentLease } from './hotelbeds-content-sync';
export { parseXml, kid, kids, at, requiredText, requiredAttr, el, xmlDocument, xmlEscape, XmlRaw, XmlParseError, DEFAULT_XML_LIMITS } from './xml/xml-parser';
export type { XmlNode, XmlLimits, XmlParseErrorCode } from './xml/xml-parser';
export { XmlSupplierTransport, InProcessGate, assertSafeEndpoint, isPrivateAddress, parseRetryAfter } from './xml/xml-transport';
export type { XmlOperation, XmlRequest, XmlTransportConfig, XmlTransportDeps, XmlResponse, TransportEvent, ConnectorGate, OperationKind } from './xml/xml-transport';
export { XmlSupplierConnector, assertOffers } from './xml/xml-connector';
export type { XmlProviderProfile, OperationSpec, SupplierFault, CertificationLevel } from './xml/xml-connector';
export { SupplierCallError, supplierAmountMinor, validateSearchQuery, isIsoDate, isOffsetTimestamp } from './xml/supplier-types';
export type * from './xml/supplier-types';
export { evaluateReadiness, ProviderProfileRegistry, PROVIDER_ONBOARDING } from './xml/readiness';
export { SharedConnectorGate, sharedGateKey, DEFAULT_SHARED_GATE_LIMITS } from './xml/shared-gate';
export type { GateStore, GateAcquireResult, GateOutcome, SharedGateLimits, SharedGateEvent, SharedConnectorGateOptions } from './xml/shared-gate';
export { fanOutRead } from './fanout/supplier-fanout';
export type { SupplierLeg, FanoutOptions, FanoutResult, LegResult, FanoutLegEvent } from './fanout/supplier-fanout';
export type { ConnectorRuntimeState, ReadinessReport, ReadinessGate, ProviderOnboarding } from './xml/readiness';
export * from './ingest'
