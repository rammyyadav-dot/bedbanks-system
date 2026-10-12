import { evaluateReadiness, PROVIDER_ONBOARDING } from '@bedbanks/connectors-core'
it('the connector kit loads in the API runtime module system', () => {
  const state = { active: true, hasCredentialReference: true, secretResolverBound: true, endpointAllowlisted: true, sharedGateBound: true, governedMappingsPresent: true, executionAuditWired: true }
  expect(evaluateReadiness('webbeds', null, state)).toMatchObject({ certification: 'NOT_IMPLEMENTED', searchable: false, bookable: false })
  expect(PROVIDER_ONBOARDING.map((p) => p.provider)).toEqual(['webbeds', 'tbo', 'darina'])
})
