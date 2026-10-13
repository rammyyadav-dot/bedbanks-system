# ADR 0059: Guided rate plan setup, cancellation terms frozen at booking, and browser journeys

## Status
Accepted. Completes the build started in ADR 0057 and 0058. Nothing here enables payment or changes who may do what.

## 1. Guided rate plan setup (S4)
A new plan opens a four-step setup at `/rates/plans/:id/setup`: plan terms, prices and stock, children and promotions, review and go live. The server's own
readiness checks decide what is done; the screen only orders them into steps and lists what is still needed. A check the screen does not know is shown on the
review step, so a new server rule cannot be skipped by the guided flow. Going live is still a request that a second person approves (ADR 0057, S5). The existing
full plan page is unchanged and linked from every step.

## 2. Cancellation terms frozen at booking (finding F13)
**Decision:** what the buyer was shown when booking is what governs the cancellation and the voucher, whatever the contract says later.
- An Agent booking stores the plan's cancellation rules, the set they came from and the instant, on `Booking.cancellationPolicy` (the same shape manual bookings already used; Admin finance already reads it).
- Cancellation quote, cancellation and the voucher read the frozen terms. Unreadable frozen terms stop the action for manual review; they are never treated as free.
- A rule that cannot be stored faithfully (a fixed penalty in another currency) stops the booking instead of falling back to live rules.
- Bookings made before this change have no frozen terms and keep reading the live rules. They are the only ones that can drift; they are not rewritten, because their terms at booking time are unknown.
- The rule lead-time limit in the shared validator was raised from 3,650 to 100,000 days so a legitimate long-lead rule is never silently unfreezable.

## 3. Promotions visible on offers
Offers carry the name and kind of the promotion already included in the price (informational; the total is final and nothing is deducted again).

## 4. Browser journeys (`e2e/`)
Real-browser tests against the real API, Admin, Agent portal, PostgreSQL and Redis; see `e2e/README.md` for the journeys and their limits. They found a defect
that type-check, lint and unit tests had not: a server page passing a function to a client component. That is the reason they exist.

## Consequences
- The remaining open items are outside this build: hosted provisioning and certification (S0, a person), per-date guest prices, channel eligibility, and driving booking and payment through the browser.
- The journeys are not a substitute for the strict-role boot smoke; both run.
