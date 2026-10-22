# ADR 0080, phase 2: migration (superseded draft)

**Superseded by `apps/api/prisma/migrations/202612030001_commercial_cascade_fx_margin_chain`**, created 2026-10-22 on the owner's go-ahead. The SQL below was the first sketch and had wrong table names; the migration file is the source of truth. Differences: quoted PascalCase table names; `agency_tier_id` removed (no tier table exists, so it would have no foreign key; it follows the tier-model decision); enum types instead of text; the backfill sets `CLIENT` for rules naming an agency or market. Not yet applied to any persistent environment: the ADR 0013 runtime-grant decision still stands before that.

Original status line: **draft for review.** This was deliberately outside `apps/api/prisma/migrations`. CLAUDE.md: a database change needs a reviewed Prisma migration, rollback notes and a tenant-index review, and the runtime-role grant decision from ADR 0013 / 0031. Do not use `prisma migrate dev` to generate production history.

## Shape (expand-only, additive, nullable or defaulted)
```sql
-- commercial_markup_rules: layer, adjustment kind, fixed amount, flat-base toggle, extra targets
ALTER TABLE commercial_markup_rules
  ADD COLUMN layer              text   NOT NULL DEFAULT 'SUPPLIER_CONTRACT',
  ADD COLUMN adjustment_kind    text   NOT NULL DEFAULT 'PERCENT',
  ADD COLUMN base               text   NOT NULL DEFAULT 'RUNNING',
  ADD COLUMN fixed_amount_minor bigint,
  ADD COLUMN fixed_currency     char(3),
  ADD COLUMN country_code       char(2),
  ADD COLUMN city               text,
  ADD COLUMN star_rating        int,
  ADD COLUMN chain_code         text,
  ADD COLUMN agency_tier_id     text;
ALTER TABLE commercial_markup_rules
  ADD CONSTRAINT cmr_layer_chk CHECK (layer IN ('SUPPLIER_CONTRACT','AGENCY_TIER','CLIENT','GLOBAL_OVERRIDE')),
  ADD CONSTRAINT cmr_kind_chk  CHECK (adjustment_kind IN ('PERCENT','FIXED','SET_SELL')),
  ADD CONSTRAINT cmr_base_chk  CHECK (base IN ('RUNNING','NET')),
  ADD CONSTRAINT cmr_fixed_chk CHECK ((adjustment_kind = 'PERCENT' AND fixed_amount_minor IS NULL AND fixed_currency IS NULL)
                                   OR (adjustment_kind <> 'PERCENT' AND fixed_amount_minor >= 0 AND fixed_currency IS NOT NULL)),
  ADD CONSTRAINT cmr_setsell_chk CHECK (adjustment_kind <> 'SET_SELL' OR layer = 'GLOBAL_OVERRIDE');
CREATE INDEX cmr_tenant_layer_status_idx ON commercial_markup_rules (tenant_id, layer, status);
-- Existing partial unique index (one ACTIVE rule per target) must be rebuilt to include the new target columns and layer.

-- fx_rates: volatility margin and freshness
ALTER TABLE fx_rates
  ADD COLUMN volatility_bp int NOT NULL DEFAULT 0,
  ADD COLUMN as_of timestamptz,            -- when the mid rate was quoted; null on legacy rows
  ADD CONSTRAINT fx_vol_chk CHECK (volatility_bp BETWEEN 0 AND 500 AND buffer_bp + volatility_bp <= 2500);

-- hotels: chain
ALTER TABLE hotels ADD COLUMN chain_code text;
CREATE INDEX hotels_tenant_chain_idx ON hotels (tenant_id, chain_code);
```
Margin and parity thresholds (tenant default, channel override) go in the existing tenant-settings mechanism (ADR 0006), not a new table, unless the review finds per-channel rows need their own.

## Review checklist
- Forced RLS and the runtime-role `GRANT`s cover the new columns (tables already have them); strict-role contract (`runtime-role-contract.ts`) unchanged.
- Existing rows keep their meaning: defaults reproduce single-layer percent behaviour; the equivalence spec `markup-cascade-adapter.spec.ts` pins it.
- Legacy FX rows have null `as_of`: the loader must treat them as **expired** (fail closed), not fresh, and the screen must say so. Operators re-activate through maker-checker.
- Tenant-index review: every new query is `tenant_id`-first.

## Rollback
Columns are additive: stop reading them (flag off) and the old path is unchanged. A forward migration may drop them; no data outside these columns is touched. Rebuilt unique index: keep the old one until the new one is validated, then drop.
