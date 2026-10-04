import { Logger, ServiceUnavailableException } from '@nestjs/common'
import { COMMERCIAL_CONTROL_UNAVAILABLE } from '@bedbanks/contracts'
import { databaseErrorCode, isDatabasePermissionDenied } from '../database/db-errors'

/**
 * Mandatory commercial controls (ADR 0031). Search, recheck and hold must be able to read these before they may return a
 * sellable offer. A valid absence of configuration (no agency, no restriction, no markup rule) is a documented default;
 * a control that cannot be read, or reads back malformed, is a failure and never an unrestricted or zero-markup answer.
 */
export type CommercialControl = 'agency_suspension' | 'distribution_restrictions' | 'markup_rules'
export type CommercialControlFailure = 'denied' | 'failed' | 'malformed'

export class CommercialControlUnavailableError extends Error {
  constructor(readonly control: CommercialControl, readonly reason: CommercialControlFailure, readonly databaseCode?: string) {
    super('A mandatory commercial control could not be read')
    this.name = 'CommercialControlUnavailableError'
  }
}

/** Wraps any read error for one control. Never carries the original message: it can contain table names or values. */
export function controlReadFailure(control: CommercialControl, error: unknown): CommercialControlUnavailableError {
  if (error instanceof CommercialControlUnavailableError) return error
  return new CommercialControlUnavailableError(control, isDatabasePermissionDenied(error) ? 'denied' : 'failed', databaseErrorCode(error))
}

/** The sanitized 503 body (existing `{message, code}` exception shape). */
export function commercialControlException(): ServiceUnavailableException {
  return new ServiceUnavailableException({ message: 'A required commercial control could not be verified, so the request was refused. Try again later or contact support.', code: COMMERCIAL_CONTROL_UNAVAILABLE })
}

/** Structured internal diagnostic. Control name, failure kind, SQLSTATE and request id only: no SQL, schema, connection or payload. */
export function logCommercialControlFailure(logger: Logger, error: CommercialControlUnavailableError, requestId: string | undefined): void {
  logger.error(JSON.stringify({ event: 'commercial_control_unavailable', control: error.control, reason: error.reason, dbCode: error.databaseCode ?? null, requestId: requestId ?? 'unknown' }))
}
