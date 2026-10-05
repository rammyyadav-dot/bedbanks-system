export type ConnectorCapability = 'search' | 'recheck' | 'prebook' | 'book' | 'cancel' | 'content' | 'availability' | 'webhook';
export interface ConnectorContext { tenantId: string; correlationId: string }
export interface ConnectorAdapter {
  readonly provider: string;
  readonly capabilities: readonly ConnectorCapability[];
  health(context: ConnectorContext): Promise<'healthy' | 'degraded' | 'unhealthy'>;
}
export { HotelbedsSandboxTransport, SandboxError, hotelbedsAedMinor, normalizeHotelbedsResponse, validateSandboxSearch, retryAfter } from './hotelbeds-sandbox.js';
export type { SandboxContext, SandboxScope, SandboxConfig, HotelbedsObservation } from './hotelbeds-sandbox.js';
export { syncHotelbedsContent } from './hotelbeds-content-sync.js';
export type { ContentStagingStore, ContentLease } from './hotelbeds-content-sync.js';
