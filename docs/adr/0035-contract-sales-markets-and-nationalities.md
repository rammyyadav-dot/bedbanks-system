# ADR 0035: Contract sales markets and guest nationalities are enforced

## Status
Accepted for the API code, Admin copy and tests in this change. No migration, no table, no permission and no privilege change: both lists already exist on `Contract` (`sales_markets`, `nationalities`, JSON arrays, default `[]`).

## Context
A contract records the buyer markets it is sold to and the guest nationalities it accepts, but Agent search ignored both (called out in ADR 0021 and 0033). A contract meant for one market was sold to every agency. Separately, recheck priced a stored offer with a hard-coded nationality of `AE`, because the offer did not remember who searched.

## Decision

### 1. Semantics (fail closed)
- An **empty** list restricts nothing. That is every existing contract, because the column defaults to `[]`.
- A **non-empty `salesMarkets`** list is an allow-list against the buyer's market: the **country code of the agency the user belongs to** (`Agency.countryCode`). A user with no agency, or an agency with no country, has an unknown market, and an unknown market never satisfies a list.
- A **non-empty `nationalities`** list is an allow-list against the **guest nationality of the search** (`criteria.nationality`, ISO-3166 alpha-2). A missing or malformed nationality never satisfies a list.
- Both lists must pass. A list that is **malformed** (not an array of two-letter codes, or more than 250 entries) makes the contract unsellable to every buyer (`CONTRACT_MARKET_RULE_INVALID`), never unrestricted.
- Codes are matched case-insensitively after trimming; stored values are normalized to upper case, sorted and de-duplicated on write.

### 2. One evaluator, buyer-aware only when a buyer exists
`evaluateContractedStay` takes an optional `buyer: { nationality, market }`. Agent search, recheck and hold pass it, and the rules (`apps/api/src/supply/market-rules.ts`, pure) are then enforced with the reasons `SOURCE_MARKET_NOT_ALLOWED`, `NATIONALITY_NOT_ALLOWED` and `CONTRACT_MARKET_RULE_INVALID`. Admin diagnostics (readiness, calendar, Sellability Inspector, rate certification, the simulator) name no buyer and therefore stay buyer-independent: a restricted contract is not reported "unsellable" because of a market, and the audit reports the restriction as information. A restricted offer is simply absent from that agency's results; no total is ever returned for a refused stay.

### 3. Recheck and hold apply the same rule to the same buyer
The stored offer now carries the searched `nationality`, so recheck no longer assumes `AE`. The buyer market is re-read from the caller's agency on recheck, so an agency whose country changed, or another user presenting a stored offer id, is judged on their own market. An offer stored before this change has no nationality and therefore fails closed for a nationality-restricted contract. Hold goes through recheck, and prebook proves the claim of a hold that recheck already allowed, so no path books a refused buyer.

### 4. A failed read is not "unknown"
The agency country is read through `loadBuyerMarket`. A denied or failed read throws `CommercialControlUnavailableError` (control `buyer_market`, 503 `COMMERCIAL_CONTROL_UNAVAILABLE`, ADR 0031) rather than showing a market-restricted contract on a guess. The read happens only when a candidate contract restricts sales markets. `Agency` and `AgencyMember` are already SELECT-granted to the strict runtime role.

### 5. Writes are validated
`createContract` and `updateContract` accept only lists of two-letter codes (otherwise 400) and store them normalized. Existing rows are not rewritten; a legacy malformed row is surfaced by the rate certification audit and refused by search until corrected.

### 6. Out of scope
Prices never depend on market or nationality (no market rates). Distribution restrictions (ADR 0019) are a separate, agency-specific hide list and are unchanged; the two compose, and either one hides a plan. Child ages and other guest attributes are not rules.

## Consequences
- Behaviour change for sellers: any contract that already carries a market or nationality list now stops selling to buyers outside it. Before applying to a persistent database, run the rate certification audit (`CONTRACT_MARKET_RESTRICTED`) to list every contract that will change, and confirm each list is intended and that each agency has a country code (an agency without one can no longer buy a market-restricted contract).
- Agencies need `countryCode` maintained. The Admin Clients module already edits it.
- No rollback migration is needed. Reverting the code restores the previous (unenforced) behaviour; clearing a list reopens that contract at once.
