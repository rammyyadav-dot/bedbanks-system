# ADR 0019: Clients, Service and Distribution

## Status
Accepted. Adds the reviewed migration `202610100001_clients_service_distribution`, applied only to disposable local databases. It carries conditional `GRANT`s for the API runtime role, which are production privilege changes in effect and need the ADR 0013 human decision before any persistent environment. These three departments were built without business rules from the owner of the business, so every choice below is a conservative default for you to confirm or change.

## Context
Agents & Clients, Service Operations and Distribution were catalogued (ADR 0015) but had no schema, API or rules. Building them invents policy, so each is kept to what can be done without touching money, credit, prices or booking state.

## Decisions
### Clients
1. **An agency is a directory record:** a tenant-unique code, a name, an optional ISO country, notes, and an ACTIVE or INACTIVE status. A user belongs to at most one agency per tenant.
2. **INACTIVE is a directory state only.** It does not block sign-in, search or booking. Making suspension mean something is the `agency.suspend` S3 action (maker-checker, ADR 0016) and is not built.
3. **Not built:** commercial profiles, credit limits and wallet limits. Those are finance authority and need their own decisions.

### Service
4. **A case is a support record** (subject, description, category, priority, status) with optional links to a booking, hotel, supplier and agency. It observes those records and never changes them.
5. **A fixed state machine:** OPEN to IN_PROGRESS or CLOSED; IN_PROGRESS to RESOLVED or OPEN; RESOLVED to CLOSED or IN_PROGRESS; CLOSED is final. Moves use an optimistic update so two people cannot make the same move. The API role has INSERT and SELECT only on notes, so the trail is append-only.
6. **Assignees must hold `case.manage`.** Audit events carry identifiers and statuses, never the free text. The UI warns not to enter guest names, contact details or card data; the system cannot detect them.

### Distribution
7. **A restriction hides one hotel, or all of one supplier's inventory, from the members of one agency** in Agent search, recheck and hold. It only narrows what an agency sees: it never grants access, changes a price or moves money. At most one ACTIVE restriction per agency and target (partial unique index); retiring re-exposes.
8. **Enforcement point.** The contracted-inventory adapter filters plans at search and refuses recheck for a restricted target, so a restricted user cannot recheck another user's offer id. Search for contracted inventory is not cached, so the per-agency filter cannot leak through the tenant search cache. Other (external) suppliers are not filtered.
9. **(Superseded by ADR 0031: an unreadable restriction table now refuses search and recheck; the text below is the original policy.) Explicit policy when restrictions are unreadable.** If the API database role cannot read the restriction table (ADR 0013), no restrictions are applied and the adapter logs a warning. Failing closed would blank every agent search until the grant is reviewed, an outage the owner did not choose. The Admin Distribution page reports the same denial, so the gap is visible. Revisit once the grant exists.
10. **Direct changes, no approval.** A restriction is a narrowing action, so it takes effect when `distribution.manage` holders create it. Whether it should need a second person is left to the business.

### Permissions
11. Six new keys (`agency.read/manage`, `case.read/manage`, `distribution.read/manage`) are seeded into the global `Permission` table by the migration and granted to no role. They are enforced from formal roles only by the same fail-closed guard as the supply keys. They appear in `/admin/operations/capabilities` so the sidebar can hide what a user cannot use; the API remains the authorizer.

## Consequences
- Three departments are live in the catalogue, sidebar and dashboard. Escalation policies, commercial profiles, credit and markets or channels remain unbuilt.
- Rollback is a later forward migration (statements in the header). Restrictions vanish from search the moment they are retired or the table is dropped.
