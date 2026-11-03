# ADR 0111: Booking workflow email notification standard

Status: Accepted. The plain-text standard and its dispatch checks are implemented. SMTP delivery of these templates is not.

## Context
Hotel, supplier, agent, voucher and internal booking notices were described as one operational standard. Booking status, payment status and voucher status are different facts. A supplier acknowledgment is receipt, not confirmation. Hotel and supplier notices carry the contracted procurement value. Agent notices carry the agent price and commission. The traveler voucher carries neither the net rate, the commission, the margin nor credit. Every deadline includes a date, a time and a time zone. A scheduled reminder must be checked again immediately before it is sent.

The checkout confirmation email (ADR 0066) remains the message queued in `BookingEmail` when an agent booking is confirmed. It is rendered from the issued voucher and invoice. This standard does not replace that outbox.

## Decision
The standard lives in `@bedbanks/domain` as pure functions. They take already validated records, format money with integer minor units, and return plain text plus a notification key. They do not read the database and they do not send mail.

- An LPO may say Confirmed only when explicit acceptance or the contractual guarantee is true. Acknowledgment alone stays "Awaiting Supplier Confirmation".
- Nightly rates, taxes and extras must add to the LPO total in one currency. Agent commission is deducted from the payable total only when the treatment is Deductible. The internal margin is revenue less procurement, commission and direct costs in the reporting currency, calculated once.
- A voucher is rendered only when the supplier is confirmed and payment has cleared or credit is approved. Version 2 and later require a change summary and state that earlier versions are invalid.
- Auto-release is refused unless the terms allow it, the deadline has passed, and payment, approved credit and any extension are absent. A cancellation request stays pending until the supplier confirms it.
- Supplier confirmation reminders stop when the booking is confirmed, cancelled or superseded. Agent deadline reminders stop when payment or credit is in place, or when the deadline has already passed.
- The notification key is one per tenant, booking, template, event and recipient reference. The recipient reference is an identifier, not an email address. Transient delivery failures are retried; permanent failures are escalated.
- Unresolved brackets, credential-like wording, and commercial phrases that belong to another audience are rejected.

## Not built
These templates are not queued, sent, or stored. There is no new table, migration, or SES path. Recipient addresses, tenant branding, and the scheduler that would call `prepareScheduledReminder` before render are separate work. The ADR 0066 confirmation email is unchanged. Do not describe these templates as messages the platform sends.
