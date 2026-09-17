# fBeds public website

The website is the public marketing, portal-routing and qualified-enquiry surface. It does not implement authentication or operational portal features.

## Configuration

| Variable | Exposure | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Public | Canonical production origin used by metadata, sitemap and robots. |
| `NEXT_PUBLIC_AGENT_URL` | Public | Independently deployed agent portal origin. |
| `NEXT_PUBLIC_SUPPLIER_URL` | Public | Independently deployed supplier portal origin. |
| `NEXT_PUBLIC_ADMIN_URL` | Public | Independently deployed operations portal origin. |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Public | Published contact and form-fallback address. |
| `FBEDS_LEAD_ENDPOINT_URL` | Server only | Approved HTTPS lead receiver. Never prefix this variable or its credentials with `NEXT_PUBLIC_`. |

URLs are normalized without trailing slashes. Local portal defaults are available only outside production; missing production portal URLs route to an explicit configuration notice instead of localhost.

## Lead endpoint contract

The server sends `POST application/json` with `fullName`, `businessEmail`, `company`, `market`, `businessType`, `monthlyVolume`, `interestArea`, `message`, and `consent`. The receiver must return a 2xx JSON response with `{ "accepted": true }`; it may include a string `reference`. A 2xx response without explicit acceptance is treated as a failure. Credentials belong in server-only deployment configuration.

When no endpoint exists, the form reports that online submission is not configured and shows the published email fallback. It never reports a successful submission without endpoint confirmation.

## Analytics and privacy

Event names use lower-case snake case and describe an interaction, not a person: `primary_cta_selected`, `portal_link_selected`, `demo_form_started`, `demo_form_validation_failed`, `demo_submission_attempted`, and `demo_submission_succeeded`. Allowed properties are fixed UI context such as `placement` or `portal`. Names, email addresses, company names, messages, tokens and form contents must never be included.

## Security headers

`next.config.ts` applies a Content Security Policy with `frame-ancestors 'none'`, `object-src 'none'`, and `base-uri 'self'`, plus Permissions Policy, strict referrer handling, MIME sniffing protection and frame denial. HSTS and insecure-request upgrades apply only in production. Any new third-party script or connection requires an explicit CSP review.

## Legal and brand dependencies

Privacy, terms and cookie routes are intentionally unpublished until legally approved text is supplied. Social handles, customer marks, certifications and customer claims are omitted until verified. The repository visibility decision is an owner-level governance dependency; never commit secrets to this repository regardless of visibility.

## Validation

Run `pnpm --filter @bedbanks/website test` for real Node tests and `pnpm --filter @bedbanks/website check:links` for route integrity. The test command fails when no test files are discovered or when an assertion fails.
