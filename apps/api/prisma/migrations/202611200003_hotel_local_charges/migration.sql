-- ADR 0067 (F-04): structured local charges paid at the hotel (Tourism Dirham, city tax, municipality and resort fees).
--
-- A JSON array on the hotel profile: [{ kind, label, amountMinor (string, integer minor units), currency, basis, maxNights }]. The API validates the
-- whole set on save; the column only guarantees it is an array. Agent offers, vouchers, invoices and the confirmation email disclose the charges with
-- an estimate for the stay; they are never added to the price.
--
-- Isolation and grants: HotelProfile keeps its forced RLS. The runtime role already holds table-level SELECT, INSERT and UPDATE on HotelProfile
-- (Hotel Setup), so the new column needs no grant change.
--
-- Tenant-index review: no new index; the column is read with the profile row by hotel id.
--
-- Rollback (forward migration; reviewed before use): ALTER TABLE "HotelProfile" DROP COLUMN "local_charges";

ALTER TABLE "HotelProfile" ADD COLUMN "local_charges" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "HotelProfile" ADD CONSTRAINT "HotelProfile_local_charges_array_check" CHECK (jsonb_typeof("local_charges") = 'array' AND jsonb_array_length("local_charges") <= 10);
