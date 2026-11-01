# Production migration release checklist (template)

Status: **TEMPLATE. Nothing below has been executed.** Every cell is `Pending` until the named owner attaches evidence through the approved private release channel and records only its reference here. Do not paste connection strings, credentials or row data (CLAUDE.md invariant 7). This template supplements `docs/postgres-production-release-checklist.md` and `docs/runbooks/neon-staging-migrations.md` (ADR 0075); it does not replace them.

| Field | Value |
|---|---|
| Release git SHA | Pending |
| Chain digest (`node tools/migration-ledger-check.mjs chain`) | Pending |
| Pending migrations expected (`--expect-pending`) | Pending |
| Release owner / database owner / recovery owner | Pending |
| Maintenance window | Pending |

## 1. Pre-flight (repository)

| # | Gate | Command / evidence | Result | Sign-off |
|---|---|---|---|---|
| 1.1 | Architecture checks | `pnpm check:architecture` | Pending | Pending |
| 1.2 | Type-check, lint, unit tests | `pnpm type-check && pnpm lint && pnpm test` | Pending | Pending |
| 1.3 | Prisma schema valid, client generated | `pnpm --filter @bedbanks/api prisma:validate` | Pending | Pending |
| 1.4 | Migration safety (content + FK index baseline) | `pnpm check:migration-safety` (CI passes `--base`; `--all` is noisy by design) | Pending | Pending |
| 1.5 | Ledger/chain integrity, no new ID collisions | `node tools/migration-ledger-check.mjs` | Pending | Pending |
| 1.6 | Every migration in scope has rollback notes and a tenant-index review (section 5) | Per-migration table | Pending | Pending |
| 1.7 | ADR exists for each architectural choice | `docs/adr` reference | Pending | Pending |

## 2. Integration testing on database branches

Disposable CI replay (`ci.yml`, pgvector pg16) is **engineering evidence only**, not persistent-environment evidence.

| # | Gate | Evidence | Result | Sign-off |
|---|---|---|---|---|
| 2.1 | CI: `prisma:migrate:deploy` + `migrate:status` on disposable DB | CI run URL for the release SHA | Pending | Pending |
| 2.2 | CI: strict-role, RLS, tenant/database security certification (`test:security`), full `test:e2e`, `prisma:migrate:drift` | CI run URL | Pending | Pending |
| 2.3 | Neon `staging` branch reset from production head | `Neon staging migration` run URL (reset = true) | Pending | Pending |
| 2.4 | Pending count on staging equals expected | `staging-migration-evidence` artifact | Pending | Pending |
| 2.5 | Verdict `STAGING_CERTIFIED`; `gitSha` = release SHA; `chain.digest` matches 'Chain digest' above | Artifact | Pending | Pending |
| 2.6 | Runtime login probes: not superuser/BYPASSRLS, owns nothing, denied probes denied | Artifact | Pending | Pending |
| 2.7 | Forced RLS on all tenant tables; tenant A/B read and write negative tests | Artifact / test output | Pending | Pending |
| 2.8 | Old and new application versions both run against the migrated schema (rollback compatibility) | Smoke results | Pending | Pending |
| 2.9 | End-to-end golden path against staging (auth, search, booking, cancellation, wallet; idempotency replays) | Test run reference | Pending | Pending |

Stop conditions: a failed or edited-checksum migration, divergent history, or `MIGRATED_RUNTIME_ROLE_UNVERIFIED`. Never `migrate resolve`, edit applied migrations, reset production or hand-edit `_prisma_migrations`. Fix forward in a new commit and re-run with reset.

## 3. Production window

| # | Step | Evidence | Result | Sign-off |
|---|---|---|---|---|
| 3.1 | Production branch protected; PITR window confirmed | `neon-staging-branch.sh status` | Pending | Pending |
| 3.2 | Restore point created and restore command saved with change record | `neon-staging-branch.sh restore-point --production main --label <sha>` | Pending | Pending |
| 3.3 | Backup ID and restore drill | Backup ID, restore time | Pending | Pending |
| 3.4 | Production `_prisma_migrations` read-only check: no failed/unfinished rows, checksums match committed files | Query output reference | Pending | Pending |
| 3.5 | Migrate with owner credential via direct endpoint (or ECS one-off task `<sha>-migrate`) | Run reference | Pending | Pending |
| 3.6 | `prisma:migrate:status:owner` up to date | Output reference | Pending | Pending |
| 3.7 | Runtime role re-provisioned and verified (`strict-role-rollout.md`) | Output reference | Pending | Pending |
| 3.8 | Deploy API first, then dependent apps | Deploy references | Pending | Pending |
| 3.9 | HTTPS auth and golden-path smoke checks | Results | Pending | Pending |
| 3.10 | Monitoring, access-audit logging and alerts checked during window | Dashboard reference | Pending | Pending |

Abort criteria (owner to confirm): Pending. Forward-fix owner: Pending. Restore owner: Pending. Owner approval decision: **Pending**.

## 4. After release

| # | Step | Result | Sign-off |
|---|---|---|---|
| 4.1 | Record deployed version, migration state and rollback point (`docs/runbooks/deploy.md` step 5) | Pending | Pending |
| 4.2 | Delete restore-point branch once release accepted | Pending | Pending |
| 4.3 | Remove runner credential files; confirm no secrets in logs/artifacts | Pending | Pending |
| 4.4 | Update `docs/postgres-production-release-checklist.md` environment table with evidence references | Pending | Pending |

## 5. Per-migration review

`Rollback notes` and `Tenant-index review` must be completed by a reviewer per migration in this release; list only the migrations pending for this release (the full chain below is the inventory at template creation). "SQL mentions rollback" is a mechanical grep, not a review.

| Migration | SQL mentions rollback | Rollback notes reviewed | Tenant-index review | Reviewer |
|---|---|---|---|---|
| `20260101000000_baseline_identity` | no | Pending | Pending | Pending |
| `20260910000000_p0d_authentication` | no | Pending | Pending | Pending |
| `202609160001_agent_domain_foundation` | no | Pending | Pending | Pending |
| `202609180001_prisma_tenant_finance_hardening` | no | Pending | Pending | Pending |
| `202609180002_postgres_release_controls` | no | Pending | Pending | Pending |
| `202609190001_supplier_hotel_master` | no | Pending | Pending | Pending |
| `202609190002_contract_commercial_rules` | no | Pending | Pending | Pending |
| `202609190003_rate_availability_inventory` | no | Pending | Pending | Pending |
| `202609190004_connector_registry_foundation` | no | Pending | Pending | Pending |
| `202609200001_platform_admin_access_foundation` | no | Pending | Pending | Pending |
| `202609210001_platform_permission_catalog` | no | Pending | Pending | Pending |
| `202609220001_supply_permissions` | no | Pending | Pending | Pending |
| `202609230001_platform_role_management_permissions` | no | Pending | Pending | Pending |
| `202609230001_supplier_mapping_governance` | no | Pending | Pending | Pending |
| `202609250001_booking_concurrency_foundation` | no | Pending | Pending | Pending |
| `202609260001_authoritative_rate_amount_semantics` | no | Pending | Pending | Pending |
| `202609270001_supplier_admin_permissions` | no | Pending | Pending | Pending |
| `202609280001_hold_expiry_system_audit_policy` | yes | Pending | Pending | Pending |
| `202610010001_tenant_settings` | yes | Pending | Pending | Pending |
| `202610010002_membership_authenticated_user` | yes | Pending | Pending | Pending |
| `202610010003_hotel_search_index` | yes | Pending | Pending | Pending |
| `202610020001_inventory_hold_processing_state` | yes | Pending | Pending | Pending |
| `202610030001_inventory_hold_confirmed_state` | yes | Pending | Pending | Pending |
| `202610040001_cancellation_one_per_booking` | yes | Pending | Pending | Pending |
| `202610050001_booking_documents` | yes | Pending | Pending | Pending |
| `202610060001_supplier_extranet_membership` | yes | Pending | Pending | Pending |
| `202610070001_supplier_mutation_journal` | yes | Pending | Pending | Pending |
| `202610080001_approval_requests` | yes | Pending | Pending | Pending |
| `202610090001_commercial_markup_rules` | yes | Pending | Pending | Pending |
| `202610100001_clients_service_distribution` | yes | Pending | Pending | Pending |
| `202610110001_agency_suspension` | yes | Pending | Pending | Pending |
| `202610120001_hotel_profile` | yes | Pending | Pending | Pending |
| `202610130001_hotel_amenities` | yes | Pending | Pending | Pending |
| `202610140001_agency_credit_limit` | yes | Pending | Pending | Pending |
| `202610150001_hotel_images` | yes | Pending | Pending | Pending |
| `202610160001_inventory_allotment_foundation` | yes | Pending | Pending | Pending |
| `202610160002_inventory_pool_tenant_guard` | yes | Pending | Pending | Pending |
| `202610170001_strict_runtime_role_contract` | yes | Pending | Pending | Pending |
| `202610180001_hotel_trigram_search` | yes | Pending | Pending | Pending |
| `202610180001_strict_runtime_role_write_set` | yes | Pending | Pending | Pending |
| `202610190001_strict_runtime_role_hotel_setup_writes` | yes | Pending | Pending | Pending |
| `202610200001_strict_runtime_role_tenant_integrity` | yes | Pending | Pending | Pending |
| `202610210001_agency_accounts` | yes | Pending | Pending | Pending |
| `202610220001_agency_funding_receipts` | yes | Pending | Pending | Pending |
| `202610230001_agency_account_credit_line` | yes | Pending | Pending | Pending |
| `202610240001_daily_rate_amount_positive` | yes | Pending | Pending | Pending |
| `202610250001_pool_capacity_permissions` | yes | Pending | Pending | Pending |
| `202610260001_strict_runtime_role_pool_capacity` | yes | Pending | Pending | Pending |
| `202610270001_strict_runtime_role_pool_freshness` | yes | Pending | Pending | Pending |
| `202610280001_pool_night_request_permissions` | yes | Pending | Pending | Pending |
| `202610290001_supplier_sandbox_content_staging` | no | Pending | Pending | Pending |
| `202610290002_supplier_sandbox_system_audit` | yes | Pending | Pending | Pending |
| `202610290003_role_permission_tenant_rls` | yes | Pending | Pending | Pending |
| `202611010001_booking_status_ten_values` | yes | Pending | Pending | Pending |
| `202611020001_booking_ops_model` | yes | Pending | Pending | Pending |
| `202611030001_booking_view_permissions` | yes | Pending | Pending | Pending |
| `202611040001_booking_action_permissions` | yes | Pending | Pending | Pending |
| `202611040002_booking_event_action_idempotency` | yes | Pending | Pending | Pending |
| `202611050001_booking_supplier_jobs` | yes | Pending | Pending | Pending |
| `202611060001_booking_ops_state` | yes | Pending | Pending | Pending |
| `202611070001_booking_document_cancellation_note` | yes | Pending | Pending | Pending |
| `202611070002_booking_finance` | yes | Pending | Pending | Pending |
| `202611080001_booking_saved_views` | yes | Pending | Pending | Pending |
| `202611090001_booking_bulk_operations` | yes | Pending | Pending | Pending |
| `202611100001_hotel_archive` | no | Pending | Pending | Pending |
| `202611100002_tenant_control_center` | no | Pending | Pending | Pending |
| `202611110001_hotel_export_permission` | yes | Pending | Pending | Pending |
| `202611120001_rate_plan_validity_payment_type` | yes | Pending | Pending | Pending |
| `202611120002_cancellation_policy_sets` | yes | Pending | Pending | Pending |
| `202611130001_rate_plan_markets` | yes | Pending | Pending | Pending |
| `202611140001_rate_plan_expiry_system_audit_policy` | yes | Pending | Pending | Pending |
| `202611150001_rate_plan_clone_guard` | yes | Pending | Pending | Pending |
| `202611160001_rate_plan_guest_prices` | yes | Pending | Pending | Pending |
| `202611160001_supplier_extranet_contracts_read` | yes | Pending | Pending | Pending |
| `202611170001_booking_supplier_ownership` | yes | Pending | Pending | Pending |
| `202611170001_rate_plan_promotions` | yes | Pending | Pending | Pending |
| `202611170002_supplier_extranet_bookings_permission` | yes | Pending | Pending | Pending |
| `202611180001_auth_audit_insert_policy` | yes | Pending | Pending | Pending |
| `202611180001_rate_plan_derived_rates` | yes | Pending | Pending | Pending |
| `202611190001_booking_checkout_details_and_email_outbox` | yes | Pending | Pending | Pending |
| `202611200001_compliance_reporting_hooks` | yes | Pending | Pending | Pending |
| `202611200001_contract_versions` | yes | Pending | Pending | Pending |
| `202611200002_valid_to_is_last_night` | yes | Pending | Pending | Pending |
| `202611200003_hotel_local_charges` | yes | Pending | Pending | Pending |
| `202611200004_contract_header_terms` | yes | Pending | Pending | Pending |
| `202611200005_release_per_night` | yes | Pending | Pending | Pending |
| `202611200006_cancellation_nights_no_show_buffer` | yes | Pending | Pending | Pending |
| `202611200007_contract_supplements` | yes | Pending | Pending | Pending |
| `202611200008_promotion_combinable_partial_stay` | yes | Pending | Pending | Pending |
| `202611210001_compliance_report_classification` | yes | Pending | Pending | Pending |
| `202611220001_supplier_statement_reconciliation` | yes | Pending | Pending | Pending |
| `202611230001_booking_export_permissions` | yes | Pending | Pending | Pending |
| `202611230001_ledger_integrity_guards` | yes | Pending | Pending | Pending |
| `202611240001_booking_checkout_job` | yes | Pending | Pending | Pending |
| `202611250001_booking_amendment_finance_type` | yes | Pending | Pending | Pending |
| `202611250001_hotel_search_indexes` | yes | Pending | Pending | Pending |
| `202611250002_booking_amendments` | yes | Pending | Pending | Pending |
| `202611250003_booking_ledger_touched` | yes | Pending | Pending | Pending |
| `202611260001_booking_close_job` | yes | Pending | Pending | Pending |
| `202611270001_markup_client_market_tiers` | yes | Pending | Pending | Pending |
| `202611270002_controlled_fx_rates` | yes | Pending | Pending | Pending |
| `202611270003_fx_compliance_classification` | yes | Pending | Pending | Pending |
| `202611270004_supplier_extranet_bookings_answer_permission` | yes | Pending | Pending | Pending |
| `202611270005_supplier_change_sets` | yes | Pending | Pending | Pending |
| `202611280001_hotel_search_hot_path` | yes | Pending | Pending | Pending |
| `202611290001_distribution_credentials` | yes | Pending | Pending | Pending |
| `202611300001_distribution_auth_context` | yes | Pending | Pending | Pending |
| `202612010001_booking_finance_posting` | yes | Pending | Pending | Pending |
| `202612020001_booking_posting_revenue_columns` | yes | Pending | Pending | Pending |
| `202612020002_supplier_ingest_system_audit` | yes | Pending | Pending | Pending |
| `202612020003_supplier_ingest_observations` | yes | Pending | Pending | Pending |
| `202612030001_supplier_rate_plan_mapping` | yes | Pending | Pending | Pending |
| `202612030002_supplier_settlements` | yes | Pending | Pending | Pending |
| `202612040001_supplier_promotion` | yes | Pending | Pending | Pending |
| `202612040002_supplier_payment_terms` | yes | Pending | Pending | Pending |
| `202612050001_hotel_deals` | yes | Pending | Pending | Pending |
| `202612050002_room_event_master` | yes | Pending | Pending | Pending |
| `202612060001_room_event_permissions` | yes | Pending | Pending | Pending |
| `202612060002_room_event_index_name` | yes | Pending | Pending | Pending |
| `202612070001_password_reset_tokens` | yes | Pending | Pending | Pending |
| `202612080001_bank_statement_reconciliation` | yes | Pending | Pending | Pending |
| `202612090001_ledger_hash_chain` | yes | Pending | Pending | Pending |
| `202612100001_booking_credit_notes` | yes | Pending | Pending | Pending |
| `202612110001_agency_commission_payout` | no | Pending | Pending | Pending |
| `202612120001_hotel_prefix_search_keys` | yes | Pending | Pending | Pending |
| `202612130001_approval_request_expiry` | yes | Pending | Pending | Pending |
