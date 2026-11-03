# ADR 0110: Wallet row lock on credit decrements

Status: **Accepted.**

## Context
A booking hold and a wallet debit both reduce what an agency can still spend. The binding hold (`BookingFinancialAuthorizationService.authorize`) already locked the wallet row before `canSpend`. The inventory-hold credit check, `LedgerService.post` for a negative entry, and the confirmation debit did not share that lock. Under read committed, a debit could commit on a balance a hold had already decided was free, and two debits through `post` could both append without either having read the other's entry.

The ledger hash chain (ADR 0094) locks the same wallet row `FOR NO KEY UPDATE` inside the insert trigger. Application code that locks `FOR UPDATE` first, then appends, keeps that order. `appendLedgerEntry` itself still takes no lock (ADR 0062): the check has to happen before the append, in the caller's transaction.

## Decision
1. **One lock.** `lockWalletRow` is `SELECT id FROM Wallet WHERE id = ? AND tenant_id = ? FOR UPDATE`. Zero rows is "wallet unavailable". The lock lasts until the caller commits or rolls back.
2. **One spend check under that lock.** `assertSpendableUnderLock` re-reads the ledger sum and the account's credit line (`accountCreditLineMinor`) and refuses with "Insufficient wallet credit" when `canSpend` fails. An idempotent replay of an existing key returns the stored entry and does not spend again.
3. **Where it runs.**
   - Booking hold authorization, before the HOLD append.
   - The inventory-hold credit check, after its per-agency advisory lock and before the position is read, when the agency account already exists. The check and the hold insert commit together, so a debit waits.
   - `LedgerService.post` for a new negative entry (a debit), before the append.
   - Booking confirmation re-reads the reservation and its release under the same lock, then appends the settling RELEASE and DEBIT. That pair nets to zero; it does not spend further credit, and it is refused when the reservation was already released.
   - The finance posting consumer locks the same row, then re-reads the booking's ledger facts, before it appends a hold or a debit. It records a charge operations already accepted; it does not apply `canSpend` (a confirmed booking is still posted when the account is over its line). A fact that moves to a different wallet after the lock is a review, not a second debit.
4. **Lock order.** Callers that also take the per-account advisory lock take it before this row lock, the order funding and finance posting already use. Confirmation still locks the booking, then the inventory hold, then the wallet.

## Consequences
- Two concurrent holds or debits on one wallet: one waits, re-reads, and is refused when the balance no longer covers it.
- A replayed idempotency key still returns the original entry.
- Rollback is a code revert. No migration, no new grant: the runtime role already holds `SELECT ... FOR UPDATE` on `Wallet`.
