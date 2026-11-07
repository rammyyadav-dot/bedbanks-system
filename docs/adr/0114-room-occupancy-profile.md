# ADR 0114: Room occupancy profile

## Status
Accepted for the Admin room-type workflow. No new table and no new column. The profile is stored in the existing `RoomType.beddingMetadata` JSON under `occupancyPolicy`, which the strict API role can already update. Rollback is a forward migration that is not required to ship: deleting the key leaves the three occupancy columns and the older rule intact.

## Context
Admin could store only max adults, max children and max occupancy, and only when the maximum was at least the sum of the other two. A bedbank room does not work that way. A deluxe room sleeps 4 guests, at most 3 adults and at most 2 children, and those maxima are not booked together. Agent search and hold already enforce the three caps separately (`maxAdults`, `maxChildren`, and `maxOccupancy >= adults + children`). The Admin rule was stricter than the sell path, so the reference room could not be saved.

Contract `ChildPolicy` remains the priced child supplement. Putting a second price on the room would invent a second evaluator.

## Decisions
1. **Two rules, one stored triple.** A create or update that sends `policy` uses the bedbank rule: max occupancy is at least the adult maximum and at most adults plus children. A request that omits `policy` keeps the ADR 0021 simultaneous-cap rule, so existing supply and hotel-setup callers do not change.
2. **The profile is room product configuration.** It records base occupancy, views, inclusions, description, minimum occupancy, minimum adults, adults allowed when children travel, extra beds, whether an extra bed consumes the maximum, an optional event maximum, a lock after the first live booking, administrator-blocked parties, and age bands from 0 through 99. Age bands do not overlap and do not leave a gap. The adult band is last and is the base rate. A child or infant percent is integer basis points (5000 = 50%), never a currency amount.
3. **One child price.** When the rate plan has CHILD guest-price lines, those stay the price. When it does not, and the room has a profile, search prices each extra child from the room band: free, or a basis-point share of one adult's portion of that night (`nightly / plan occupancy`, half up). An age in the adult band pays a full adult share. The contract child supplement is not added as well. A party the matrix marks blocked or invalid is not sold. A room with no profile keeps the previous contract-band behaviour. The oldest children still fill base places the adults left empty and pay nothing extra. One sharing child, the youngest, is not charged and does not count toward occupancy.
4. **Lock.** When the profile says lock after the first booking and a non-cancelled booking exists for the room, a save that reduces a limit is refused with `ROOM_OCCUPANCY_LOCKED`. If bookings cannot be read, the lock fails closed. Turning the lock off requires a reason. Rooms stay archived, never deleted.
5. **Meal chips** on the room card are the names of that room's active rate-plan board bases. A denied read is omitted, not shown as "no meal plan".
