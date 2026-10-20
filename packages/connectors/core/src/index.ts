export type ConnectorCapability = 'search' | 'recheck' | 'prebook' | 'book' | 'cancel' | 'content' | 'availability' | 'webhook' | 'status';
export interface ConnectorContext { tenantId: string; correlationId: string }
export interface ConnectorAdapter {
  readonly provider: string;
  readonly capabilities: readonly ConnectorCapability[];
  health(context: ConnectorContext): Promise<'healthy' | 'degraded' | 'unhealthy'>;
}
export { HotelbedsSandboxTransport, SandboxError, hotelbedsAedMinor, normalizeHotelbedsResponse, validateSandboxSearch, retryAfter } from './hotelbeds-sandbox';
export type { SandboxContext, SandboxScope, SandboxConfig, HotelbedsObservation } from './hotelbeds-sandbox';
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
