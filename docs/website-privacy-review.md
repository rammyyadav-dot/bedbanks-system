# Website privacy review (engineering input, not legal approval)

**Legal approval status: BLOCKED.** No legal or privacy owner has approved the notice. `apps/website/lib/legal-status.ts` keeps `privacyPolicyApproved = false`, which excludes `/privacy` from the sitemap and from indexing. Engineering review is not legal approval.

## Verified from the code (apps/website)
| Topic | Finding | Evidence |
| --- | --- | --- |
| Data collected by the enquiry form | Full name, business email, company, market, business type, monthly volume, interest area, message, consent flag. A hidden `website` field is checked and discarded. | `lib/leads/validation.ts`, `app/request-demo/actions.ts` |
| Where an enquiry goes | Only to `FBEDS_LEAD_ENDPOINT_URL` when configured (HTTPS enforced in production); otherwise the form reports "not configured" and shows the contact email. No receiver exists in this repository. | `lib/leads/lead-adapter.ts`; no lead model or route in `apps/api` |
| Cookies | The website's own code sets none. | No `cookies()`, `document.cookie` or storage use in `apps/website` |
| Analytics | Vercel Web Analytics, production only. Six fixed interaction events; no form contents or personal data in event properties. | `lib/analytics.ts`, `app/layout.tsx`, `components/forms/DemoRequestForm.tsx` |
| Other third-party requests | `va.vercel-scripts.com` and `vitals.vercel-insights.com` (analytics) only. | `next.config.ts` CSP, source scan |
| Terms and cookie pages | Do not exist. | `README.md` says they stay unpublished until approved |

## Questions the owner must answer (nothing below has been invented)
1. **Controller:** legal entity name, registered address and registration number.
2. **Privacy contact:** is `hello@fbeds.com` the privacy contact, or is there a dedicated address and a DPO or representative?
3. **Purposes and lawful basis:** only responding to enquiries, or also follow-up marketing? Which lawful basis for each purpose and market?
4. **Recipients and processors:** who operates the system behind `FBEDS_LEAD_ENDPOINT_URL` (CRM, email, helpdesk)? List every processor and sub-processor and the agreements in place. Which hosting provider and plan serve the site?
5. **Analytics and cookies:** does Vercel Web Analytics set any cookie or persistent identifier on the plan in use? Is consent required in the target markets? Should an opt-out be offered?
6. **Retention:** retention period for enquiries, for email correspondence, and for hosting and analytics logs.
7. **International transfers:** regions where each processor operates and the transfer mechanism (for example SCCs).
8. **Rights process:** how requests are made, response times, supervisory authority details.
9. **Terms and cookie notice:** are separate documents required before launch?
10. **Effective date** and who approves future changes.

## Before setting `privacyPolicyApproved = true`
Owner answers recorded here, final text approved in writing by the legal or privacy owner, the `[Insert ...]` placeholders removed from `app/privacy/page.tsx`, and the PR reviewed by a human.
