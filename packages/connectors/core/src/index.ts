export type ConnectorCapability = 'search' | 'recheck' | 'prebook' | 'book' | 'cancel' | 'content' | 'availability' | 'webhook' | 'status';
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
export { parseXml, kid, kids, at, requiredText, requiredAttr, el, xmlDocument, xmlEscape, XmlRaw, XmlParseError, DEFAULT_XML_LIMITS } from './xml/xml-parser.js';
export type { XmlNode, XmlLimits, XmlParseErrorCode } from './xml/xml-parser.js';
export { XmlSupplierTransport, InProcessGate, assertSafeEndpoint, isPrivateAddress, parseRetryAfter } from './xml/xml-transport.js';
export type { XmlOperation, XmlRequest, XmlTransportConfig, XmlTransportDeps, XmlResponse, TransportEvent, ConnectorGate, OperationKind } from './xml/xml-transport.js';
export { XmlSupplierConnector, assertOffers } from './xml/xml-connector.js';
export type { XmlProviderProfile, OperationSpec, SupplierFault, CertificationLevel } from './xml/xml-connector.js';
export { SupplierCallError, supplierAmountMinor, validateSearchQuery, isIsoDate, isOffsetTimestamp } from './xml/supplier-types.js';
export type * from './xml/supplier-types.js';
export { evaluateReadiness, ProviderProfileRegistry, PROVIDER_ONBOARDING } from './xml/readiness.js';
export { fanOutRead } from './fanout/supplier-fanout.js';
export type { SupplierLeg, FanoutOptions, FanoutResult, LegResult, FanoutLegEvent } from './fanout/supplier-fanout.js';
export type { ConnectorRuntimeState, ReadinessReport, ReadinessGate, ProviderOnboarding } from './xml/readiness.js';
