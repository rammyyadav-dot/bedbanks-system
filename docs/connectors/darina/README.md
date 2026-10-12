# Darina (first XML supplier)

Selected 2026-10-12 as the first supplier to connect. Status: **NOT_IMPLEMENTED, blocked on the supplier's technical pack.**

## What is known
Only public marketing: a Travelopro page describes "Darina Holidays" as offering XML integration, and Vervotech lists Darina as a mapped supplier (REST/offline content feed). Neither documents Darina's own endpoints, schema or auth.
Sources: https://www.travelopro.com/darina-holidays.php, https://www.vervotech.com/hub/master-suppliers/darina/
Nothing about Darina's protocol, authentication, codes, rate rules or limits is assumed in this repo.

## Request to send to Darina (commercial/technical contact)
1. XML (or SOAP) technical documentation, WSDL/XSD, and the interface version currently supported.
2. Sandbox endpoint plus test credentials issued to fBeds; production host(s) and any IP whitelisting.
3. Authentication scheme, credential rotation, and rate/quota limits per credential.
4. Complete error/fault code catalogue, marking auth, quota and retryable codes.
5. Static content: hotel, room and board codes, how content is delivered, code stability guarantees.
6. The flow search -> rate validation/block -> book -> cancel -> status-by-our-reference, and which calls are idempotent on their side (a client booking reference and duplicate detection).
7. Currency, tax-inclusion, nationality/market pricing, cancellation-deadline time zone, and whether rates carry an expiry.
8. Certification/go-live checklist and test scripts.

## Then, in order
1. Operators create `fbeds-<env>/connectors/<tenantId>/<connectorId>/api` in Secrets Manager (never in Terraform) and add Darina's host to `CONNECTOR_ALLOWED_HOSTS`.
2. Create the DRAFT connector via `POST /supply/connectors` (type `XML_OUT`, provider `darina`) and attach the credential reference.
3. Write the profile against the received spec (see `../xml-supplier-onboarding.md`), fixtures from real redacted sandbox responses, tests; certification stays `FIXTURE_ONLY` until their scripts pass.
4. Close the remaining gates in `../xml-supplier-api-audit-2026-10-12.md` (execution persistence, governed mappings, booking inputs, shared gate binding).
