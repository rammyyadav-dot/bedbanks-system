import {
  AMENITY_CATALOGUE, AMENITY_FEE_TYPES, BED_TYPES, EXTRA_BED_SUPPORT, ROOM_CODE_PATTERN,
  type AmenityFeeType, type AmenityScope, type AmenitySelection, type BedType, type ExtraBedSupport, type RoomBedding, type RoomSave,
} from '@bedbanks/contracts'
import { occupancyProblems } from '../supply/room-rules'

const CONTROL = /[\u0000-\u001f]/
const MAX_BEDS = 6
const MAX_AMENITIES = 80

/** The stored bedding JSON read as the known shape. Unknown keys are ignored here and preserved on write by `mergeBedding`. */
export function parseBedding(json: unknown): RoomBedding {
  const o = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  const beds = Array.isArray(o.beds) ? o.beds.filter((b): b is { type: BedType; count: number } => !!b && typeof b === 'object' && (BED_TYPES as readonly string[]).includes((b as { type?: string }).type ?? '') && Number.isInteger((b as { count?: unknown }).count) && (b as { count: number }).count >= 1 && (b as { count: number }).count <= 9) : []
  return {
    description: typeof o.description === 'string' && o.description ? o.description : null,
    beds,
    extraBed: (EXTRA_BED_SUPPORT as readonly string[]).includes(o.extraBed as string) ? (o.extraBed as ExtraBedSupport) : 'UNKNOWN',
  }
}

/** Writes the known keys into the stored JSON and leaves every other key exactly as it was. */
export function mergeBedding(existing: unknown, patch: Partial<RoomBedding>): Record<string, unknown> {
  const out: Record<string, unknown> = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {}
  if (patch.description !== undefined) { if (patch.description === null) delete out.description; else out.description = patch.description }
  if (patch.beds !== undefined) { if (patch.beds.length === 0) delete out.beds; else out.beds = patch.beds }
  if (patch.extraBed !== undefined) out.extraBed = patch.extraBed
  return out
}

export function amenityScopeOk(code: string, scope: 'HOTEL' | 'ROOM'): boolean {
  const entry = AMENITY_CATALOGUE.find((a) => a.code === code)
  return !!entry && (entry.scope === 'BOTH' || entry.scope === (scope as AmenityScope))
}

/** Validates an amenity selection against the controlled catalogue for the given scope. */
export function normaliseAmenities(value: unknown, scope: 'HOTEL' | 'ROOM', errors: string[], field = 'amenities'): AmenitySelection[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_AMENITIES) { errors.push(`${field}: provide a list of at most ${MAX_AMENITIES} selections`); return undefined }
  const out: AmenitySelection[] = []; const seen = new Set<string>()
  for (const [i, entry] of value.entries()) {
    const e = entry as { code?: unknown; feeType?: unknown }
    const code = typeof e?.code === 'string' ? e.code : ''
    const feeType = typeof e?.feeType === 'string' ? e.feeType : ''
    if (!amenityScopeOk(code, scope)) { errors.push(`${field}[${i}].code: is not in the ${scope.toLowerCase()} amenity catalogue`); continue }
    if (!(AMENITY_FEE_TYPES as readonly string[]).includes(feeType)) { errors.push(`${field}[${i}].feeType: must be FREE, PAID or UNKNOWN`); continue }
    if (seen.has(code)) { errors.push(`${field}[${i}].code: selected more than once`); continue }
    seen.add(code); out.push({ code, feeType: feeType as AmenityFeeType })
  }
  return out
}

export interface NormalisedRoom {
  fields: { name?: string; code?: string; maxAdults?: number; maxChildren?: number; maxOccupancy?: number }
  bedding?: Partial<RoomBedding>
  amenities?: AmenitySelection[]
  changed: string[]
}

/** Validates a room create or update. Unknown keys are rejected; values are never echoed into messages. */
export function normaliseRoomSave(body: Partial<RoomSave>, mode: 'create' | 'update'): { data: NormalisedRoom; errors: string[] } {
  const errors: string[] = []
  const b = (body ?? {}) as Record<string, unknown>
  const allowed = new Set(['idempotencyKey', 'expectedToken', 'reason', 'name', 'code', 'maxAdults', 'maxChildren', 'maxOccupancy', 'bedding', 'amenities'])
  for (const key of Object.keys(b)) if (!allowed.has(key)) errors.push(`${key}: is not a supported field`)
  const data: NormalisedRoom = { fields: {}, changed: [] }
  const text = (name: 'name', max: number) => {
    if (b[name] === undefined) { if (mode === 'create') errors.push(`${name}: is required`); return }
    if (typeof b[name] !== 'string' || !(b[name] as string).trim()) { errors.push(`${name}: is required`); return }
    const t = (b[name] as string).trim()
    if (t.length > max || CONTROL.test(t)) { errors.push(`${name}: must be at most ${max} characters without control characters`); return }
    data.fields[name] = t; data.changed.push(name)
  }
  text('name', 120)
  if (b.code === undefined) { if (mode === 'create') errors.push('code: is required') }
  else if (typeof b.code !== 'string' || !ROOM_CODE_PATTERN.test(b.code.trim())) errors.push('code: use 1-40 letters, digits, dots, dashes or underscores')
  else { data.fields.code = b.code.trim(); data.changed.push('code') }
  for (const k of ['maxAdults', 'maxChildren', 'maxOccupancy'] as const) {
    if (b[k] === undefined) { if (mode === 'create' && k !== 'maxChildren') errors.push(`${k}: is required`); continue }
    data.fields[k] = b[k] as number; data.changed.push(k)
  }
  if (b.bedding !== undefined) {
    const bd = b.bedding as Record<string, unknown> | null
    if (!bd || typeof bd !== 'object' || Array.isArray(bd)) errors.push('bedding: must be an object')
    else {
      const out: Partial<RoomBedding> = {}
      for (const key of Object.keys(bd)) if (!['description', 'beds', 'extraBed'].includes(key)) errors.push(`bedding.${key}: is not a supported field`)
      if (bd.description !== undefined) {
        if (bd.description === null || (typeof bd.description === 'string' && !bd.description.trim())) out.description = null
        else if (typeof bd.description !== 'string' || bd.description.length > 200 || CONTROL.test(bd.description)) errors.push('bedding.description: must be at most 200 characters')
        else out.description = bd.description.trim()
      }
      if (bd.beds !== undefined) {
        if (!Array.isArray(bd.beds) || bd.beds.length > MAX_BEDS) errors.push(`bedding.beds: provide at most ${MAX_BEDS} bed entries`)
        else {
          const beds: Array<{ type: BedType; count: number }> = []
          for (const [i, bed] of bd.beds.entries()) {
            const e = bed as { type?: unknown; count?: unknown }
            if (!(BED_TYPES as readonly string[]).includes(e?.type as string)) errors.push(`bedding.beds[${i}].type: is not a supported bed type`)
            else if (!Number.isInteger(e?.count) || (e.count as number) < 1 || (e.count as number) > 9) errors.push(`bedding.beds[${i}].count: must be a whole number from 1 to 9`)
            else beds.push({ type: e.type as BedType, count: e.count as number })
          }
          if (new Set(beds.map((x) => x.type)).size !== beds.length) errors.push('bedding.beds: each bed type may appear once')
          out.beds = beds
        }
      }
      if (bd.extraBed !== undefined) {
        if (!(EXTRA_BED_SUPPORT as readonly string[]).includes(bd.extraBed as string)) errors.push('bedding.extraBed: must be SUPPORTED, NOT_SUPPORTED or UNKNOWN')
        else out.extraBed = bd.extraBed as ExtraBedSupport
      }
      data.bedding = out; data.changed.push('bedding')
    }
  }
  const amenities = normaliseAmenities(b.amenities, 'ROOM', errors)
  if (amenities) { data.amenities = amenities; data.changed.push('amenities') }
  return { data, errors }
}

/** Occupancy problems for the merged result of an update (or a create). */
export function mergedOccupancyProblems(current: { maxAdults: number; maxChildren: number; maxOccupancy: number }, fields: NormalisedRoom['fields']): string[] {
  return occupancyProblems(fields.maxAdults ?? current.maxAdults, fields.maxChildren ?? current.maxChildren, fields.maxOccupancy ?? current.maxOccupancy)
}
