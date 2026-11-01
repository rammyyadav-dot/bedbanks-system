-- One credit concept, slice 3 of ADR 0028.
--
-- Owner decisions (2026-10-04): an agency with money and no credit line books up to its balance (prepaid); a user who belongs to no agency
-- cannot book (the house account is never charged for a booking); payment terms 7 days to an overdue notice, 30 to refusing new holds
-- (enforced in slice 4).
--
-- An agency account's credit line is its agency's approved credit limit ("AgencyCreditLimit", ADR 0024 maker-checker) in the same
-- currency. The account's own "credit_limit" column is therefore never used for agency accounts; this constraint keeps it zero so there
-- can never be a second, unapproved credit number. House accounts keep their stored limit.
--
-- No data change: no code path has ever set a credit limit on an agency account (they are opened by funding, slice 2, with the default 0).
-- Runtime role: unchanged ("Wallet" stays finance-gated, ADR 0032).
-- Rollback (a later forward migration): ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_agency_account_uses_credit_line";

ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_agency_account_uses_credit_line" CHECK ("agency_id" IS NULL OR "credit_limit" = 0);
