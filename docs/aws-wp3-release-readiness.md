# CTO release readiness decision: AWS WP3

Prepared by the engineering assistant for the CTO; **the decision below is a recommendation, not an approval.** Evidence: `docs/aws-wp3-verification-evidence.md`. Matrix: `docs/aws-wp3-gap-matrix.md`.

## Decision
| Scope | Recommendation | Why |
|---|---|---|
| Merge this pull request (repository changes only, nothing applied to AWS) | **GO.** Condition met: GitHub Actions was green on the final PR head `1bf2e33` and on the merge commit (`docs/aws-wp3-verification-evidence.md` §7). Note it was merged before those runs finished; they passed afterwards | All offline and local application, database and website checks pass; no schema, grant, role, pricing, supplier, booking or payment code changed |
| Plan and apply **staging** in AWS | **CONDITIONAL GO**: after the owner decisions and the reviewed real `terraform plan` below | Nothing has been planned against a real account; live-account behaviour is unproven |
| **Production** infrastructure, data move, DNS cutover | **NO-GO** | See blockers 1 to 7; none of the production gates in ADR 0055 is satisfied by offline evidence |
| Enable booking, payments or live supplier integrations | **NO-GO / out of scope** | unchanged; `BOOKING_ENABLED=false` is guarded in CI |

## Blockers before staging apply (owner or credentials)
1. Run `infra/aws/audit/account-audit.sh`; resolve every FAIL/UNKNOWN (Organizations, Identity Center, CloudTrail, state bucket encryption/versioning/lock).
2. Choose the staging ingress ranges (`public_ingress_cidrs`), the monthly ceiling and alert recipients, and activate the six cost tags.
3. A human reads a real `terraform plan` (checklist in the runbook and `docs/aws-staging-readiness-checklist.md`).
4. Confirm `ap-south-1` supports the chosen RDS 16 minor with `vector`/`pg_trgm`, the instance classes and the quotas.
5. Approve or reject the proposed checkov exceptions (`docs/aws-checkov-exception-register.md`); approve a retention policy (`docs/aws-log-retention-policy.md`).

## Additional blockers before production
6. Staging soak with the certification list in `docs/aws-staging-readiness-checklist.md` section E (edge bypass test, log delivery, alarm delivery, rotation drills, restore and rollback drills, image-digest equality on a Docker build).
7. Website digest promotion (runtime canonical URLs) or a recorded exception; CloudFront access-log destination; VPC Origins decision; recorded CTO GO and `dns_cutover_authorization_ref`.

## What changed in risk
Reduced: the portals no longer tie an image to one environment; alarms can now actually be delivered; logging and monitoring exist for network, load balancers, WAF and the database; Redis requires a credential; the origin cannot be reached around CloudFront once it is enabled; CI cannot go green on a ShellCheck defect unnoticed.
Introduced or accepted: a Redis AUTH token and the origin-verify secrets live in the encrypted Terraform state (documented, CI-guarded, rotation not yet drilled); the runtime proxy adds a per-request function on each portal (replacing build-time rewrites; negligible, but measure in staging); ~$15-20/month (staging) and ~$70-90/month (production) of log and WAF cost, from unverified prices.

## Owner sign-off (blank until given)
Decision: ____  Name: ____  Date: ____
