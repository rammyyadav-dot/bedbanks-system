# Launch inclusive-pricing rollout

ADR 0029 defines all-inclusive supplier nets; ADR 0115 enforces the existing rate-plan declarations at activation and sale. This rollout does not authorize deployment or clear the migration and staging-acceptance gates.

## Catalogue preparation

1. Supply and finance owners review each pilot rate plan against the supplier's agreed net terms. Verify that all taxes and mandatory charges payable by fBeds are included. Confirm any separately collected property/local charges and their guest-facing disclosure.
2. In the existing rate-plan workflow, explicitly record `taxesIncluded=true` and `feesIncluded=true` only when those terms are verified. Use the normal audited authoring/approval path, including any active-plan controls. Do not bulk backfill declarations from an assumption, a zero tax line, or previous search visibility.
3. Check activation readiness and the Sellability Inspector. `TAX_BASIS_NOT_INCLUSIVE` and `FEE_BASIS_NOT_INCLUSIVE` are blocking rate-basis reasons. A draft may still be saved with false defaults; it cannot be activated or sold until verified.
4. Recheck representative inclusive rates, amounts, cancellation terms and property-collected charges. Confirm excluded rates disappear from new searches, old offers cannot pass recheck, and failed allocations do not leave stock or holds behind.

## Release and observation

Record the reviewed catalogue, release SHA, test evidence and accountable owners in the existing release process. Keep supplier connectivity and booking/payment activation governed separately. Unknown or false declarations intentionally reduce sellable inventory; they are not a reason to disable the checks.

Monitor unexpected empty searches and the new reason codes after deployment. Continue servicing existing bookings under the existing servicing controls. For any disputed supplier basis, stop new sales for that inventory and resolve the commercial terms through operations; do not rewrite money, booking or migration history.
