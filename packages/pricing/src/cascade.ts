import { markupMinor, MAX_MARKUP_BASIS_POINTS } from './markup';

/**
 * Cascading markup (ADR 0080, proposed). Pure and transport-agnostic: BigInt minor units only, no floating point.
 *
 * Layers apply in this fixed order, each on the running amount left by the one before:
 * `BASE_RATE` (the net) -> `SUPPLIER_CONTRACT` -> `AGENCY_TIER` -> `CLIENT` -> `GLOBAL_OVERRIDE`.
 * A layer is a percent in basis points or a fixed amount in minor units of the same currency. Percent rounds half up per layer
 * (the same rule as `markupMinor`), so the result is reproducible from the trace alone.
 * `GLOBAL_OVERRIDE` can instead *set* the final sell amount (`SET_SELL`), which is how a commercial owner pins a price.
 */
export const MARKUP_LAYERS = ['SUPPLIER_CONTRACT', 'AGENCY_TIER', 'CLIENT', 'GLOBAL_OVERRIDE'] as const;
export type MarkupLayerName = (typeof MARKUP_LAYERS)[number];

export type LayerAdjustment =
  | { kind: 'PERCENT'; basisPoints: number }
  | { kind: 'FIXED'; amountMinor: bigint }
  | { kind: 'SET_SELL'; amountMinor: bigint };

export interface MarkupLayer { layer: MarkupLayerName; ruleId: string; adjustment: LayerAdjustment }

export interface LayerTraceStep { layer: MarkupLayerName; ruleId: string; kind: LayerAdjustment['kind']; beforeMinor: bigint; deltaMinor: bigint; afterMinor: bigint }

export interface CascadeResult {
  netMinor: bigint;
  sellMinor: bigint;
  markupMinor: bigint;
  trace: LayerTraceStep[];
}

const ORDER = new Map<MarkupLayerName, number>(MARKUP_LAYERS.map((layer, index) => [layer, index]));

/**
 * Prices one net amount through the layers that apply. Rejects an out-of-order, repeated or malformed layer instead of
 * guessing, and rejects any result below the net: a markup layer can never sell below cost (use the margin guard for floors).
 */
export function applyMarkupCascade(netMinor: bigint, layers: readonly MarkupLayer[]): CascadeResult {
  if (netMinor < 1n) throw new Error('Net amount must be at least one minor unit');
  let running = netMinor;
  let previous = -1;
  const trace: LayerTraceStep[] = [];
  for (const { layer, ruleId, adjustment } of layers) {
    const position = ORDER.get(layer);
    if (position === undefined) throw new Error(`Unknown markup layer ${String(layer)}`);
    if (position <= previous) throw new Error(`Markup layer ${layer} is repeated or out of order`);
    previous = position;
    let next: bigint;
    if (adjustment.kind === 'PERCENT') {
      if (!Number.isSafeInteger(adjustment.basisPoints) || adjustment.basisPoints < 0 || adjustment.basisPoints > MAX_MARKUP_BASIS_POINTS) throw new Error('Markup basis points must be an integer from 0 to 10000');
      next = running + markupMinor(running, adjustment.basisPoints);
    } else if (adjustment.kind === 'FIXED') {
      if (adjustment.amountMinor < 0n) throw new Error('A fixed markup must not be negative');
      next = running + adjustment.amountMinor;
    } else if (adjustment.kind === 'SET_SELL') {
      if (layer !== 'GLOBAL_OVERRIDE') throw new Error('Only the global override layer may set the sell amount');
      next = adjustment.amountMinor;
    } else {
      throw new Error('Unknown markup adjustment');
    }
    if (next < netMinor) throw new Error(`Layer ${layer} would sell below net`);
    trace.push({ layer, ruleId, kind: adjustment.kind, beforeMinor: running, deltaMinor: next - running, afterMinor: next });
    running = next;
  }
  return { netMinor, sellMinor: running, markupMinor: running - netMinor, trace };
}

/** Facts a rule can target. Matching is exact; a rule with no target field applies to everything in its layer. */
export interface CascadeTarget { supplierId: string; hotelId: string; countryCode: string; city: string; starRating: number | null; chainCode: string | null; agencyId: string | null; agencyTierId: string | null }
export interface CascadeRule {
  ruleId: string;
  layer: MarkupLayerName;
  adjustment: LayerAdjustment;
  supplierId?: string; hotelId?: string; countryCode?: string; city?: string; starRating?: number; chainCode?: string; agencyId?: string; agencyTierId?: string;
}

const TARGET_KEYS = ['supplierId', 'hotelId', 'countryCode', 'city', 'starRating', 'chainCode', 'agencyId', 'agencyTierId'] as const;
const matches = (rule: CascadeRule, target: CascadeTarget): boolean => TARGET_KEYS.every((key) => rule[key] === undefined || rule[key] === target[key]);
const specificity = (rule: CascadeRule): number => TARGET_KEYS.filter((key) => rule[key] !== undefined).length;

/**
 * Picks at most one rule per layer: among the matching rules of a layer the most specific wins (most target fields named).
 * Two matching rules of equal specificity in one layer is an ambiguous configuration and throws; the caller must surface it
 * (invariant 5: never fall back to a default price from a catch block).
 */
export function selectCascadeLayers(rules: readonly CascadeRule[], target: CascadeTarget): MarkupLayer[] {
  const chosen: MarkupLayer[] = [];
  for (const layer of MARKUP_LAYERS) {
    const candidates = rules.filter((rule) => rule.layer === layer && matches(rule, target));
    if (candidates.length === 0) continue;
    const top = Math.max(...candidates.map(specificity));
    const best = candidates.filter((rule) => specificity(rule) === top);
    if (best.length > 1) throw new Error(`Ambiguous ${layer} rules: ${best.map((rule) => rule.ruleId).sort().join(', ')}`);
    chosen.push({ layer, ruleId: best[0]!.ruleId, adjustment: best[0]!.adjustment });
  }
  return chosen;
}
