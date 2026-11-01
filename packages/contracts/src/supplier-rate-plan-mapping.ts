/** Governed supplier rate plan to canonical RatePlan mappings (ADR 0081). Same PENDING / MAPPED / REJECTED lifecycle as hotel and room mappings (ADR 0004). */
export type SupplierRatePlanMappingStatus = 'PENDING' | 'MAPPED' | 'REJECTED'

export interface SupplierRatePlanMappingView {
  id: string
  supplierRoomMappingId: string
  supplierRatePlanCode: string
  ratePlanId: string
  ratePlanCode: string
  contractCode: string
  currency: string
  status: SupplierRatePlanMappingStatus
  confidence: number | null
  createdAt: string
  updatedAt: string
}

export interface CreateSupplierRatePlanMappingBody { supplierRatePlanCode: string; ratePlanId: string; confidence?: number; sourceMetadata?: Record<string, unknown> }
export interface SupplierRatePlanMappingDecisionBody { reason?: string }

/** A canonical rate plan a supplier rate plan code may be mapped to: same room type, a contract with the same supplier, not derived, not yet mapped. */
export interface SupplierRatePlanMappingOption { ratePlanId: string; code: string; contractCode: string; currency: string; status: string }

export const SUPPLIER_RATE_PLAN_MAPPING_CONFLICT_CODE = 'SUPPLIER_RATE_PLAN_MAPPING_CONFLICT'
