import type { PrismaService } from '../database/prisma.service'
import { CommercialControlUnavailableError, controlReadFailure } from './commercial-controls'
import { MAX_FX_BUFFER_BP, type FxQuote } from './fx'

/**
 * The tenant's ACTIVE controlled rates into `quote` (ADR 0067, F-12), keyed by base currency. Read only when the request currency could need one.
 * Valid absence: no rate means no contract in another currency is offered. Failure: a denied or failed read, or a malformed row, throws
 * `CommercialControlUnavailableError` (ADR 0031), so a price is never converted on a guess and never silently dropped as "no rate".
 */
export async function loadActiveFxRates(prisma: PrismaService, tenantId: string, quote: string): Promise<Map<string, FxQuote>> {
  let rows: Array<{ baseCurrency: string; quoteCurrency: string; rateScaled: bigint; bufferBp: number }>
  try {
    rows = await prisma.withTenant(tenantId, (tx) => tx.fxRate.findMany({ where: { tenantId, status: 'ACTIVE', quoteCurrency: quote }, select: { baseCurrency: true, quoteCurrency: true, rateScaled: true, bufferBp: true }, orderBy: { id: 'asc' } }))
  } catch (error) {
    throw controlReadFailure('fx_rates', error)
  }
  const out = new Map<string, FxQuote>()
  for (const r of rows) {
    if (!/^[A-Z]{3}$/.test(r.baseCurrency) || r.baseCurrency === quote || r.rateScaled <= 0n || !Number.isInteger(r.bufferBp) || r.bufferBp < 0 || r.bufferBp > MAX_FX_BUFFER_BP || out.has(r.baseCurrency)) throw new CommercialControlUnavailableError('fx_rates', 'malformed')
    out.set(r.baseCurrency, { from: r.baseCurrency, to: quote, rateScaled: r.rateScaled, bufferBp: r.bufferBp })
  }
  return out
}
