# Staging access-assignment review

Status: **required before a staging acceptance sign-off**. Completing this file in the abstract does not sign anything. The security owner performs the review on the staging environment and records the result on `docs/ops/staging-acceptance-signoff.json`. Do not commit a review you did not make. Do not paste member names, email addresses, user ids or permission lists into the record (CLAUDE.md invariant 7).

The evidence surface is Admin → Risk & Compliance → **Access reviews** (`/access-review`, `apps/admin/app/(dashboard)/access-review/page.tsx`). It is read-only. Role and assignment changes happen in Roles & Permissions, then the reviewer reads this page again.

Do this for every SHA presented for staging acceptance (ADR 0112 amendment 1). A review recorded for a different SHA does not carry forward. The same row is item E on `docs/aws-staging-readiness-checklist.md` and item 2.10 on `docs/release-checklists/production-migration-release.md`.

## Steps

1. Confirm the Admin host is the staging deployment of the SHA being signed, and sign in to the operator tenant that staging will promote. Tenant identity comes from the session.
2. Open **Access reviews**. You need `audit.read`. A 403 is a failed review, not a zero count.
3. Copy `generatedAt` and the member counts from the summary: total, hold sensitive permissions, no role, inactive, never logged in, and no login in 90 days. `staleLoginDays` in the record is 90, the window the API uses.
4. For each flag, open the filter and decide one disposition:
   - `accepted` — the count is appropriate for this release, including when the count is zero. Sensitive holders are people who should hold an S3 permission (one that moves bookings or money).
   - `remediated` — assignments were changed in Roles & Permissions before this record was written, and the counts are from a second read after that change.
5. The reviewer name is the security signer's name, character for character. `reviewedAt` is when that person finished the read.
6. Run `node tools/ops/staging-signoff.mjs --sha <deployed sha>`. `SIGNED` also requires the other three roles. `OPEN` means this review is missing, names someone other than the security signer, skips a flag, disagrees with the 90-day window, or contains a member list or an email address.

## Record shape

```json
{
  "reviewer": "<security signer>",
  "reviewedAt": "2026-11-06T11:30:00+05:30",
  "generatedAt": "<generatedAt from the page>",
  "surface": "admin:/access-review",
  "staleLoginDays": 90,
  "statement": "I reviewed tenant access assignments for this SHA on the staging Access reviews page and recorded a disposition for every flag.",
  "counts": { "total": 0, "holdingSensitive": 0, "noRole": 0, "inactive": 0, "neverLoggedIn": 0, "staleLogin": 0 },
  "dispositions": {
    "HOLDS_SENSITIVE": "accepted",
    "NO_ROLE": "accepted",
    "INACTIVE": "accepted",
    "NEVER_LOGGED_IN": "accepted",
    "STALE_LOGIN": "accepted"
  }
}
```

The statement is exact. Counts are non-negative integers and no flag count may exceed `total`.
