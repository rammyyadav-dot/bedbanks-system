# Hosted Agent acceptance record (Dubai search and recheck MVP)

Fill-in record for `docs/runbooks/hosted-agent-acceptance.md`. Nothing below is evidence until a row holds real output. Never paste a secret, password, session cookie or connection string; environment variable **names** only.

## Status
| Flag | Value |
| --- | --- |
| `HOSTED_AGENT_MVP` | `NOT_VERIFIED` |
| `F01_STATUS` | `OPEN` |
| `STRICT_ROLE_ROLLOUT` | `PAUSED` |
| `/users` browser validation | unverified |
| Booking, payment, live suppliers | disabled |
| Last checked | _blank_ |

Blocker when this record was created: the Vercel connector returned 403 for scope `rammyyadav-4259s-projects`; no Agent host, API readiness, Dubai fixture or test account was confirmed.

## Deployment under test
| Item | Value |
| --- | --- |
| Project | _blank_ |
| Agent host | _blank_ |
| Deployment ID | _blank_ |
| Source SHA | _blank_ |

## 1. Project settings (names only, read-only inspection)
| Item | Expected | `fbeds-agent` | `fbeds-agent1` |
| --- | --- | --- | --- |
| Dedicated Agent project (not website) | yes | NOT_CHECKED | NOT_CHECKED |
| Root Directory | `apps/agent`, outside-root source files included | NOT_CHECKED | NOT_CHECKED |
| Framework / Node / install | Next.js, Node 24.x, `npx --yes pnpm@10.4.1 install --frozen-lockfile` | NOT_CHECKED | NOT_CHECKED |
| Production branch | `main` | NOT_CHECKED | NOT_CHECKED |
| Env var names (Production, Preview) | `API_INTERNAL_URL` (server-only, HTTPS, ends `/api/v1`); no database or supplier secret | NOT_CHECKED | NOT_CHECKED |
| Domain serves the Agent app | yes; website project and domain untouched | NOT_CHECKED | NOT_CHECKED |

## 2. Preconditions
| Item | Status |
| --- | --- |
| API ready (`/api/v1/health/ready`) | NOT_CONFIRMED |
| API connects as the strict runtime role | NOT_CONFIRMED |
| `BOOKING_ENABLED` unset or false | NOT_CONFIRMED |
| `TRUSTED_ORIGINS` covers the Agent host | NOT_CONFIRMED |
| Dubai fixture catalogue present (test data only) | NOT_CONFIRMED |
| Dedicated test agent account with `hotel.search` (not a real agency) | NOT_CONFIRMED |

## 3. Hosted smoke (`tools/deployment/hosted-agent-smoke.mjs`)
| Check | Result |
| --- | --- |
| H1 sign-in page served | NOT_RUN |
| H2 no server-only names or secrets in HTML/scripts | NOT_RUN |
| H3 same-origin `/api/v1` proxy reaches the API | NOT_RUN |
| H4 unauthenticated request is 401 | NOT_RUN |
| H5 sign-in works | NOT_RUN |
| H6 cookie host-only, HttpOnly, Secure | NOT_RUN |
| H7 context names the workspace, `bookingEnabled=false` | NOT_RUN |
| H8 Dubai resolves from the canonical catalogue | NOT_RUN |
| H9 one-room two-adult AED search returns hotels, server pagination | NOT_RUN |
| H10 canonical offer ids, AED totals | NOT_RUN |
| H11 authoritative recheck answers a defined outcome | NOT_RUN |
| H12 booking and hold endpoints are closed | NOT_RUN |
| H13 sign-out ends the session | NOT_RUN |

Script output (no credentials are printed):
```
(paste here)
```

## 4. Browser pass
| Step | Result |
| --- | --- |
| Unauthenticated visit reaches sign-in | NOT_RUN |
| Sign in; search Dubai (one room, two adults); load more | NOT_RUN |
| Open a hotel; select an offer; "Offer rechecked" with valid-until time | NOT_RUN |
| No Book, Pay or Confirm action | NOT_RUN |
| Sign out | NOT_RUN |
| 390 px width: nothing scrolls sideways | NOT_RUN |

## 5. Decision
Set `HOSTED_AGENT_MVP=PASS` only when every row above holds evidence from a real hosted deployment. On any failure, record the failing check and stop; do not change aliases, environment variables or projects as a shortcut.
