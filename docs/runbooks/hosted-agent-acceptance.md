# Runbook: hosted Agent acceptance (Dubai search and recheck MVP)

Executed by the project owner against a **deployed** Agent (a protected preview first, then production when authorized). It does not deploy, change environment variables or move aliases. `HOSTED_AGENT_MVP` stays `NOT_VERIFIED` until section 3 passes against a real hosted deployment and section 1 is checked by someone with Vercel access. Local evidence is in `docs/agent-dubai-mvp-completion.md`.

## 0. Preconditions
- An isolated API is deployed and reachable from the Agent project (`/api/v1/health/ready` returns ready), with `BOOKING_ENABLED` unset or false, connected as the strict runtime role (`docs/runbooks/strict-role-rollout.md`), and `TRUSTED_ORIGINS` covering the Agent host.
- A Dubai fixture catalogue exists in that API's database (contracted hotels with rates and availability for the dates below). Use test data only.
- An **authorized test agent account** with `hotel.search` in one workspace. Never use a real agency account.

## 1. Project settings checklist (Vercel dashboard, read-only inspection)
| Item | Expected |
| --- | --- |
| Project | the dedicated Agent project (not the website project) |
| Root Directory | `apps/agent`; "include source files outside the Root Directory" enabled |
| Framework / Node / install | Next.js, Node 24.x, `npx --yes pnpm@10.4.1 install --frozen-lockfile` (from `apps/agent/vercel.json`) |
| Production branch | `main` |
| Environment variable **names** (Production and Preview separately) | `API_INTERNAL_URL` (server-only, HTTPS, ends in exactly `/api/v1`, no credentials, query or fragment, not loopback). `NEXT_PUBLIC_AGENT_API_URL` only if required. No database or supplier secret in this project |
| Rewrites | generated at build time: changing `API_INTERNAL_URL` needs a rebuild |
| Domain | the Agent host serves the Agent app; the public website project and domain are untouched |
Record the values you see (names only; never copy a secret value) in the acceptance record.

## 2. Config guard (anyone, offline)
`node --test tools/deployment/config.test.mjs tools/deployment/hosted-agent-smoke.test.mjs` and, for the Agent, `VERCEL=1 node -e "import('./apps/agent/next.config.mjs')"` must fail with "API_INTERNAL_URL is required" when the variable is missing.

## 3. Hosted smoke (read-only apart from one sign-in session)
```
HOSTED_AGENT_URL=https://<agent host> \
HOSTED_AGENT_EMAIL=<test agent email> \
HOSTED_AGENT_PASSWORD=<test agent password> \
node tools/deployment/hosted-agent-smoke.mjs
```
Pass the credentials from your secret manager; the script never prints them or the session cookie, and refuses a non-HTTPS target (`--allow-local-http` exists for localhost rehearsals only). It checks, over the public same-origin paths:

| Check | Meaning |
| --- | --- |
| H1, H2 | the Agent serves its sign-in page and neither HTML nor scripts contain `API_INTERNAL_URL`, connection strings or connector secrets |
| H3, H4 | the same-origin `/api/v1` proxy reaches the API; an unauthenticated request is 401 |
| H5, H6, H7 | sign-in works; the session cookie is host-only, HttpOnly and Secure; the server context names the workspace and reports `bookingEnabled` (expect `false`) |
| H8, H9, H10 | Dubai resolves from the canonical catalogue; a one-room two-adult AED search returns hotels with server pagination; offers have canonical ids and AED totals |
| H11 | the authoritative recheck answers `rechecked`, `price_changed`, `unavailable` or `offer_expired` |
| H12 | booking and hold endpoints answer an error (closed) |
| H13 | sign-out ends the session |

It creates one session and nothing else: no hold, booking, payment or inventory change. Exit code 0 means all 13 passed.

## 4. Browser pass (manual, 10 minutes)
Open the Agent host in a clean browser: unauthenticated visit reaches sign-in; sign in; search Dubai (one room, two adults); load more; open a hotel; select an offer and read "Offer rechecked" with its valid-until time; confirm there is no Book, Pay or Confirm action; sign out. At 390 px width confirm nothing scrolls sideways.

## 5. Recording the result
Add to the PR or release record: deployment ID and URL, source SHA, the project settings observed (names only), the smoke output, and the browser pass notes. Only then set `HOSTED_AGENT_MVP=PASS`. If any step fails, record the failing check and stop; do not change aliases or environment variables as a troubleshooting shortcut.

## Rehearsal evidence
The same script passed 13/13 against the local production build and the real API on the strict runtime login (`docs/evidence/agent-dubai-mvp/hosted-smoke-local.txt`). That is a rehearsal, not hosted evidence.
