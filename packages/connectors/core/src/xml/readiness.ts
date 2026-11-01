import type { CertificationLevel, XmlProviderProfile } from './xml-connector'

/**
 * Honest readiness: a supplier is "connectable" only when every gate passes with evidence. Registering a name or
 * storing a ConnectorDefinition row is not a capability (CLAUDE.md invariant 10).
 */
export interface ConnectorRuntimeState {
  /** ConnectorDefinition.status === 'ACTIVE' */
  active: boolean
  hasCredentialReference: boolean
  /** A secret manager resolver is bound in this deployment (not the unconfigured one). */
  secretResolverBound: boolean
  endpointAllowlisted: boolean
  /** Shared (multi-process) rate gate bound, required before more than one worker may call the supplier. */
  sharedGateBound: boolean
  /** Hotel and room mapping coverage is governed (ADR 0004/0009), not invented from supplier codes. */
  governedMappingsPresent: boolean
  /** Persisted, redacted ConnectorExecution rows are written for every call. */
  executionAuditWired: boolean
}
export interface ReadinessGate { id: string; passed: boolean; detail: string }
export interface ReadinessReport { provider: string; certification: CertificationLevel; gates: ReadinessGate[]; searchable: boolean; bookable: boolean }

const ORDER: CertificationLevel[] = ['NOT_IMPLEMENTED', 'FIXTURE_ONLY', 'SANDBOX_CERTIFIED', 'PRODUCTION_CERTIFIED']
const atLeast = (have: CertificationLevel, need: CertificationLevel): boolean => ORDER.indexOf(have) >= ORDER.indexOf(need)

export function evaluateReadiness(provider: string, profile: XmlProviderProfile<never> | null, state: ConnectorRuntimeState): ReadinessReport {
  const certification: CertificationLevel = profile?.certification ?? 'NOT_IMPLEMENTED'
  const caps = new Set(profile?.capabilities ?? [])
  const gates: ReadinessGate[] = [
    { id: 'profile-implemented', passed: !!profile && certification !== 'NOT_IMPLEMENTED', detail: profile ? `profile ${profile.profileVersion}` : 'no provider profile exists; supplier specification not yet implemented' },
    { id: 'connector-active', passed: state.active, detail: 'ConnectorDefinition must be ACTIVE' },
    { id: 'credential-reference', passed: state.hasCredentialReference, detail: 'ConnectorCredentialReference with a secret-manager reference' },
    { id: 'secret-resolver', passed: state.secretResolverBound, detail: 'a real secret resolver is bound (not the unconfigured resolver)' },
    { id: 'endpoint-allowlist', passed: state.endpointAllowlisted, detail: 'supplier host is in the deployment egress allowlist' },
    { id: 'governed-mappings', passed: state.governedMappingsPresent, detail: 'hotel and room mappings come from governed mapping, not supplier codes' },
    { id: 'execution-audit', passed: state.executionAuditWired, detail: 'redacted ConnectorExecution rows are persisted per call' },
    { id: 'shared-gate', passed: state.sharedGateBound, detail: 'credential-wide rate/circuit state is shared across processes' },
    { id: 'sandbox-certified', passed: atLeast(certification, 'SANDBOX_CERTIFIED'), detail: `certification is ${certification}` },
  ]
  const common = gates.every((g) => g.passed)
  const prod = atLeast(certification, 'PRODUCTION_CERTIFIED')
  return {
    provider, certification, gates,
    // Search may be exposed to agents only with search+recheck, because an unrechecked supplier rate has no expiry.
    searchable: common && prod && caps.has('search') && caps.has('recheck'),
    bookable: common && prod && caps.has('book') && caps.has('cancel') && caps.has('status'),
  }
}

/** What must be obtained from each supplier before a profile can be written. Facts about their APIs are NOT asserted here. */
export interface ProviderOnboarding { provider: string; displayName: string; status: 'NOT_IMPLEMENTED'; requiredFromSupplier: string[] }
const COMMON_REQUIREMENTS = [
  'Current official API specification and schema/WSDL for the XML interface (version pinned in the profile)',
  'Sandbox/test endpoint and credentials issued to fBeds, stored only as secret-manager references',
  'Production endpoint host(s) to add to the egress allowlist, and any IP whitelisting the supplier requires',
  'Authentication scheme (credential placement, signing or token lifecycle) and credential rotation process',
  'Rate/quota limits per credential, and the supplier error-code catalogue including auth, quota and retryable codes',
  'Static content strategy (hotel/room/board codes, content download or push) and the code stability guarantee',
  'Search -> rate validation (recheck/block) -> book -> cancel -> status-by-reference flow, and which calls are idempotent on the supplier side',
  'Currency, tax-inclusion, nationality/market and cancellation-policy semantics, including time zone of deadlines',
  'Certification/go-live checklist and the supplier test scripts they require',
]
export const PROVIDER_ONBOARDING: readonly ProviderOnboarding[] = Object.freeze([
  { provider: 'webbeds', displayName: 'WebBeds', status: 'NOT_IMPLEMENTED', requiredFromSupplier: COMMON_REQUIREMENTS },
  { provider: 'tbo', displayName: 'TBO', status: 'NOT_IMPLEMENTED', requiredFromSupplier: COMMON_REQUIREMENTS },
  { provider: 'darina', displayName: 'Darina', status: 'NOT_IMPLEMENTED', requiredFromSupplier: COMMON_REQUIREMENTS },
])

/** Profiles are registered explicitly at composition time. An unknown provider resolves to null, never to a stand-in. */
export class ProviderProfileRegistry {
  private readonly profiles = new Map<string, XmlProviderProfile<never>>()
  register(profile: XmlProviderProfile<never>): void {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(profile.provider) || this.profiles.has(profile.provider)) throw new Error('Invalid or duplicate provider profile')
    this.profiles.set(profile.provider, profile)
  }
  get(provider: string): XmlProviderProfile<never> | null { return this.profiles.get(provider) ?? null }
  providers(): string[] { return [...this.profiles.keys()] }
}
