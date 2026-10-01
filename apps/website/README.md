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
| `FBEDS_LEAD_SIGNING_SECRET` | Server only | Shared HMAC secret (32+ characters) for signing lead requests. Required whenever the endpoint is set. |

URLs are normalized without trailing slashes. Local portal defaults are available only outside production; missing production portal URLs route to an explicit configuration notice instead of localhost.

The website-specific local ports are `3000` for this public site, `3001` for Admin, `3003` for Agent and `3004` for Supplier. Start this app with `pnpm --filter @bedbanks/website dev -- -p 3000`.

## Lead path and protections

Path: browser form -> Server Action `submitDemoRequest` (`app/request-demo/actions.ts`) -> `processLeadSubmission` -> `submitLead` -> receiver at `FBEDS_LEAD_ENDPOINT_URL`. **No receiver or persistence exists in this repository**; the receiver is an external system the owner must provide.

Protections implemented here:

1. Server-side validation of every field, with length limits (name 120, email 254, company 160, market 120, message 2000), and a Server Action body limit of 32 kb (`next.config.ts`).
2. Honeypot: a filled hidden field returns the same generic success as an accepted lead, creates no lead and makes no downstream call (after a short random pause).
3. Signed downstream request: HMAC-SHA256 over `timestamp.nonce.body` with the server-only `FBEDS_LEAD_SIGNING_SECRET` (32+ characters), sent as `x-fbeds-timestamp`, `x-fbeds-nonce`, `x-fbeds-signature` (`v1=<hex>`). No signed secret, no request: the website never sends an unsigned lead. Redirects are refused. In production the endpoint must be HTTPS, public and credential-free.
4. Best-effort per-client rate limit (5 per 10 minutes). It is per server instance, so on serverless hosting it is **not** the primary control.
5. Sanitized failures: users see generic messages; server logs carry reason codes only, never lead fields, the endpoint, the secret or response bodies.

The receiver contract: accept `POST application/json` with `fullName`, `businessEmail`, `company`, `market`, `businessType`, `monthlyVolume`, `interestArea`, `message`, `consent`; verify the signature with `verifyLeadRequest` (`lib/leads/signing.ts`: timestamp window of 300 s, constant-time comparison, replay rejection) using a nonce store shared by all receiver instances; return 2xx JSON `{ "accepted": true }`. Anything else is treated as a failure. When no endpoint is configured the form says so and shows the email address; it never reports success without receiver confirmation. A success screen is identical for accepted leads and honeypot hits, so no reference is shown.

Remaining blockers (not solvable inside this repository):

- **Edge rate limiting.** Add a rate-limit rule for `POST /request-demo` in the hosting firewall (for Vercel: Firewall custom rule). I have not verified which plan features are available or configured anything.
- **Receiver verification.** The receiver must implement the signature check above; this repository cannot enforce it.
- A CAPTCHA or managed bot product would need owner approval (cost and privacy impact).

## Deployment

The website deploys from its own Vercel project with **Root Directory `apps/website`** and "Include source files outside of the Root Directory" enabled. Its configuration is `apps/website/vercel.json`; leave the dashboard Build Command and Output Directory overrides off. **Admin must be a separate project** (Root Directory `apps/admin`, plus `API_INTERNAL_URL` and `AUTH_API_ORIGIN`); the same applies to Agent and Supplier. There is no root `vercel.json`, no `vercel-build` script and no publish script: a project with a blank Root Directory is not a supported way to deploy the website.

## Fonts

The site uses a system font stack (`--font-body` in `app/globals.css`) and makes no remote font requests at build or run time (guarded by `tests/fonts.test.ts`). No licensed brand font file exists in the repository. To add one, obtain the font and its licence from the owner, store both under `app/fonts/`, load only the needed weights with `next/font/local`, and expose it through `--font-body`.

## Analytics and privacy

Event names use lower-case snake case and describe an interaction, not a person: `primary_cta_selected`, `portal_link_selected`, `demo_form_started`, `demo_form_validation_failed`, `demo_submission_attempted`, and `demo_submission_succeeded`. Allowed properties are fixed UI context such as `placement` or `portal`. Names, email addresses, company names, messages, tokens and form contents must never be included.

## Security headers

`next.config.ts` applies a Content Security Policy with `frame-ancestors 'none'`, `object-src 'none'`, and `base-uri 'self'`, plus Permissions Policy, strict referrer handling, MIME sniffing protection and frame denial. HSTS and insecure-request upgrades apply only in production. Any new third-party script or connection requires an explicit CSP review.

## Legal and brand dependencies

Privacy, terms and cookie routes are intentionally unpublished until legally approved text is supplied. Social handles, customer marks, certifications and customer claims are omitted until verified. The repository visibility decision is an owner-level governance dependency; never commit secrets to this repository regardless of visibility.

## Validation

Run `pnpm --filter @bedbanks/website test` for real Node tests and `pnpm --filter @bedbanks/website check:links` for route integrity. The test command fails when no test files are discovered or when an assertion fails.
