# Onboarding an XML supplier (WebBeds, TBO, Darina, ...)

Status of each supplier today: **NOT_IMPLEMENTED**. No profile exists, no credentials are held, no supplier
specification has been reviewed in this repository. Nothing below asserts how any supplier's API behaves; those facts
must come from the supplier's current official documentation and certification pack.

## Steps (in order, one supplier at a time)

1. **Obtain from the supplier** (see `PROVIDER_ONBOARDING` in `packages/connectors/core/src/xml/readiness.ts`): spec/WSDL,
   sandbox endpoint and credentials, production hosts, rate limits, error catalogue, static-content method, the
   search -> validate -> book -> cancel -> status flow, tax/currency/cancellation semantics, certification scripts.
2. Create `docs/connectors/<provider>/` with spec version, quirks, mapping ownership and certification notes. No secrets.
3. Put credentials in the secret manager. Store only the reference in `ConnectorCredentialReference.secretRef`.
4. Write `packages/connectors/<provider>/` (or `core/src/<provider>/`) exporting an `XmlProviderProfile`:
   `faultOf`, and `search`/`recheck`/`book`/`cancel`/`status` specs. Parse money with `supplierAmountMinor`; require
   offset-qualified cancellation deadlines; return `null` for expiry/tax when the supplier is silent. Provider types
   must not escape the package (CLAUDE.md invariant 9).
5. Record real (redacted, no guest data) sandbox responses as fixtures; add the provider's tests, including the cases in
   `test/xml-connector.test.mjs` (fault mapping, malformed rejection, mutation `maybe_sent`, no secret leakage).
6. Set `certification: 'SANDBOX_CERTIFIED'` only after the supplier's sandbox scripts pass with evidence in the connector
   record; `PRODUCTION_CERTIFIED` only after supplier sign-off.
7. Close the platform gates listed in the audit, then bind the profile: add the host to the egress allowlist, register the
   profile in `ProviderProfileRegistry`, resolve `BookingSupplierRegistry.resolve()` to an `XmlBookingSupplier` for that
   tenant only when `evaluateReadiness(...).bookable` is true.
8. Staged rollout: one tenant, search only, then book/cancel with a monitored runner and a supplier-side reconciliation.

## Hard rules for profiles

- Never return an empty or demo result from a failure path; throw `SupplierCallError`.
- Never retry or re-send a mutation yourself. Never log request/response bodies, rate tokens, credentials or guest data.
- Never derive canonical IDs from supplier names; hotel and room identity comes from governed mappings.
