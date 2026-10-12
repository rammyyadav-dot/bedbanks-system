# ADR 0058: Promotions and derived rates, pricing policy

## Status
Accepted as the policy for slice S10 of ADR 0057 (decision D7: "promotions and derived rates wait for a pricing-policy ADR"). The policy is deliberately conservative: where a rule could be read two ways, the stricter reading is chosen and the loosening is left to a later, explicit decision. S10a (promotions) is implemented first; S10b (derived rates) follows. Each section below states what is implemented. Nothing here enables booking or payment.

## Principles (inherited, restated because they decide edge cases)
1. Money is integer minor units. No floating point anywhere in pricing.
2. One evaluator prices every surface (Agent search, recheck, hold, simulator, readiness). A rule that is not in the evaluator is not a rule.
3. Fail closed. An unreadable, ambiguous or inconsistent price makes the stay unsellable with a typed reason. It is never priced as free, never "best effort".
4. The buyer's price can never silently become zero or negative: every nightly net after any adjustment is at least 1 minor unit (ADR 0034).
5. Rounding is half up, on integer minor units, at one fixed place per rule (stated below), and the simulator recomputes it independently.

## Order of operations for one night of one room
```
base nightly rate            (DailyRate, or the derived rate: S10b)
+ guest lines                (child / extra adult, ADR 0057 S6)
= nightly net before promotion
- promotion                  (S10a: at most ONE promotion applies to a stay)
= nightly net after promotion  (>= 1)
+ markup on that net         (NET rates only; half up per night, ADR 0018)
= nightly sell
```
The room total is the sum of nightly sells; the stay total multiplies by rooms. SELL-basis rates carry no markup, so the promotion reduces the sell price directly.

## Promotions (S10a, implemented)
A promotion belongs to one rate plan.

| Kind | Applies when | Effect |
|---|---|---|
| `EARLY_BIRD` | booking lead >= `minLeadDays` | `percentBp` off every night |
| `LAST_MINUTE` | booking lead <= `maxLeadDays` | `percentBp` off every night |
| `LONG_STAY` | nights >= `minNights` | `percentBp` off every night |
| `FREE_NIGHTS` | nights >= `minNights` | the `freeNights` cheapest nights are free (ties: the later date is the free one) |

- **Booking lead** is whole days from today in the **hotel's calendar** to check-in (the same rule as release days). An unknown hotel time zone means the promotion does not apply; it is never guessed.
- **Windows.** Optional booking window (`bookFrom`..`bookTo`, hotel-local today inside it, inclusive) and optional stay window (`stayFrom`..`stayTo`: **every night** of the stay inside it, inclusive). A promotion with a window it does not satisfy does not apply.
- **No stacking.** At most one promotion applies to a stay: the one with the **largest saving for that stay**; a tie goes to the lowest id. This is the stricter reading of "stacking" and is stable. Stacking, if ever wanted, needs a new decision and a new order of operations.
- **Percent rounding.** Per night, half up on the nightly net: `discount = (net * bp + 5000) / 10000` in integers. The discount is capped so the net stays >= 1. `percentBp` is limited to 1..9000 (90%); a fully free night is expressed only by `FREE_NIGHTS`.
- **FREE_NIGHTS** sets the chosen nights' net to zero **for the promotion only**, and the stay must still contain at least one paid night (`freeNights` < `nights`); a stay that would be entirely free is not sold.
- The markup is applied to the discounted net, so a promotion is a supplier-side saving that the platform margin follows (a NET plan's sell price falls by the discounted amount plus its markup).
- The decision records which promotion applied and the saving per room, so the simulator and the audit can explain a price. The offer's total already includes it.
- **Authoring** needs `supply.rates.manage`, is validated as a whole, version-checked against the plan, audited with before and after, and moves the plan version (so an activation approval filed on other prices is void). Promotions are part of the approval fingerprint. A clone does not copy them (they are prices).

## Derived rates (S10b)
(Specified here so the policy is whole; implemented in the next slice and marked as such in ADR 0057.)
- A derived plan sells at its **parent's nightly rate for the same date plus or minus** an adjustment: `PERCENT_BP` (signed basis points, half-up on the magnitude then signed) or `FIXED_MINOR` (signed minor units). It has **no rate rows of its own**; rate edits on a derived plan are refused.
- **Depth one.** A parent must not itself be derived, so cycles cannot exist by construction; the evaluator refuses a derived plan whose parent is derived.
- **Same shape.** Parent and derived plan must share contract, hotel, currency and occupancy. The basis (NET or SELL) is the parent's night's basis.
- The derived nightly rate must be >= 1; a night where the adjustment would make it zero or negative makes **that night** (and so the stay) unsellable.
- A derived plan keeps its **own availability, restrictions and pool membership**; only the price is derived. Guest lines and promotions of the derived plan apply on top of the derived rate, exactly as for any plan.

## Not decided here
Per-date guest lines; stacking; promotions on a contract or hotel scope; coupon codes or channel-only promotions; fixed-amount promotions; loyalty. Each needs its own decision.
