import type { HotelbedsSandboxTransport, SandboxContext } from './hotelbeds-sandbox.js'

/** The sink must atomically stage a page and advance its checkpoint under the lease.
 * No implementation in this slice writes canonical content, mappings or inventory.
 */
export interface ContentStagingStore {
  checkpoint(context: SandboxContext, runId: string, lastUpdateTime: string | null): Promise<number>
  /** The implementation must check the lease/fencing token, CAS the checkpoint and
   * bind the run to lastUpdateTime in the SAME atomic commit as page staging. */
  commitPage(context: SandboxContext, input: { runId: string; lastUpdateTime: string | null; leaseToken: string; expectedFrom: number; nextFrom: number; hotels: unknown[]; receivedAt: string }): Promise<void>
}
export interface ContentLease {
  acquire(key: string, ttlMs: number): Promise<{ key: string; token: string } | null>
  release(lease: { key: string; token: string }): Promise<void>
}
export interface ContentSyncResult { nextFrom: number; pages: number; staged: number; complete: boolean }
/** Explicitly invoked and bounded. No scheduler and no deletion inference.
 * Uses the existing coordination port structurally; a NoopCoordination cannot proceed.
 */
export async function syncHotelbedsContent(
  transport: Pick<HotelbedsSandboxTransport, 'contentPage'>, store: ContentStagingStore,
  coordination: ContentLease, context: SandboxContext, options: { runId: string; maxPages: number; lastUpdateTime?: string },
): Promise<ContentSyncResult> {
  if (![context.tenantId, context.supplierId, context.connectorId, options.runId].every(v => /^[a-zA-Z0-9_-]{1,100}$/.test(v)) ||
      !Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 5) throw new Error('Invalid sandbox synchronization scope')
  const key = `fbeds:sandbox-content:${context.tenantId}:${context.supplierId}:${context.connectorId}`
  const lease = await coordination.acquire(key, 60_000)
  if (!lease) throw new Error('Sandbox synchronization lease unavailable')
  const started = Date.now()
  let pages = 0, staged = 0
  try {
    let from = await store.checkpoint(context, options.runId, options.lastUpdateTime ?? null)
    if (!Number.isSafeInteger(from) || from < 1) throw new Error('Invalid synchronization checkpoint')
    while (pages < options.maxPages) {
      if (context.signal?.aborted || Date.now() - started >= 45_000) throw new Error('Sandbox synchronization interrupted')
      const raw = await transport.contentPage(from, from + 99, context, options.lastUpdateTime)
      const page = raw as { from?: unknown; to?: unknown; total?: unknown; hotels?: unknown; error?: unknown }
      if (!page || page.error !== undefined || page.from !== from || !Number.isSafeInteger(page.to) ||
          (page.to as number) < from || (page.to as number) > from + 99 || !Number.isSafeInteger(page.total) ||
          (page.total as number) < 0 || !Array.isArray(page.hotels) || page.hotels.length > 100) throw new Error('Invalid sandbox content page')
      // No stale worker writes after its lease safety window.
      if (Date.now() - started >= 45_000) throw new Error('Sandbox synchronization lease safety window exceeded')
      const codes = page.hotels.map(rawHotel => {
        if (!rawHotel || typeof rawHotel !== 'object' || Array.isArray(rawHotel)) throw new Error('Invalid sandbox content hotel')
        const code = (rawHotel as { code?: unknown }).code
        if (!Number.isSafeInteger(code) || (code as number) <= 0) throw new Error('Invalid sandbox content hotel')
        return code
      })
      if (new Set(codes).size !== codes.length) throw new Error('Duplicate sandbox content hotel')
      const nextFrom = (page.to as number) + 1
      await store.commitPage(context, { runId: options.runId, lastUpdateTime: options.lastUpdateTime ?? null, leaseToken: lease.token, expectedFrom: from, nextFrom, hotels: page.hotels, receivedAt: new Date().toISOString() })
      staged += page.hotels.length
      pages++
      from = nextFrom
      if ((page.to as number) >= (page.total as number)) return { nextFrom: from, pages, staged, complete: true }
    }
    return { nextFrom: from, pages, staged, complete: false }
  } finally { await coordination.release(lease) }
}
