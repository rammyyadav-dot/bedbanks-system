import { Prisma } from '@prisma/client';

/**
 * Structural tenant guard (ADR 0104, CLAUDE.md invariant 1).
 *
 * `PrismaService.withTenant` hands work a transaction client whose model delegates are wrapped here, so every read,
 * write and delete on a model with a required `tenantId` column carries the server-derived tenant even if the caller
 * forgot it. This is a third wall beside forced RLS (`app.current_tenant_id`) and the `check:tenant-filter` CI gate:
 * a connection that bypasses RLS, or a hand-written `where: { id }`, still cannot cross tenants.
 *
 * - where (find*, count, aggregate, groupBy, update*, delete*, upsert): `tenantId` is pinned. A different `tenantId` throws.
 * - data (create, createMany*, update*, upsert): a missing `tenantId` is injected, a different one throws.
 * - Models with an optional `tenantId` (rows that may be global) are not rewritten; they stay on RLS and the CI gate.
 * - Raw SQL is not rewritten; `check:raw-sql` and RLS cover it.
 * - `TENANT_SCOPE_GUARD=off` disables the wrapper (emergency rollback only; logged by the caller at startup).
 */
export class TenantScopeViolation extends Error {
  constructor(model: string, operation: string) {
    super(`Tenant scope violation: ${model}.${operation} named a tenant other than the active tenant`);
    this.name = 'TenantScopeViolation';
  }
}

const WHERE_OPS = new Set(['findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'findMany', 'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany', 'upsert']);
const DATA_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

let requiredTenantModels: Set<string> | undefined;
/** Delegate names (`ledgerEntry`) of models whose `tenantId` is a required scalar. */
export function tenantScopedDelegates(): Set<string> {
  requiredTenantModels ??= new Set(
    Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'tenantId' && f.kind === 'scalar' && f.isRequired))
      .map((m) => m.name[0].toLowerCase() + m.name.slice(1)),
  );
  return requiredTenantModels;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

function pinWhere(where: unknown, tenantId: string, model: string, op: string): Record<string, unknown> {
  const base = isPlain(where) ? where : {};
  const named = base.tenantId;
  if (named !== undefined && named !== tenantId) {
    // Filter objects ({ equals }, { in }) are legitimate only when they cannot select another tenant.
    const ok = isPlain(named) && named.equals === tenantId && Object.keys(named).length === 1;
    if (!ok) throw new TenantScopeViolation(model, op);
  }
  return { ...base, tenantId };
}

function pinRow(row: unknown, tenantId: string, model: string, op: string): unknown {
  if (!isPlain(row)) return row;
  if (row.tenantId !== undefined && row.tenantId !== tenantId) throw new TenantScopeViolation(model, op);
  // Checked-create input names the tenant by relation; adding the scalar beside it makes Prisma reject the call.
  if ('tenant' in row) return row;
  return { ...row, tenantId };
}

function guardArgs(model: string, op: string, args: unknown, tenantId: string): unknown {
  const a = isPlain(args) ? { ...args } : {};
  if (WHERE_OPS.has(op) && op !== 'upsert') a.where = pinWhere(a.where, tenantId, model, op);
  if (op === 'upsert') {
    a.where = pinWhere(a.where, tenantId, model, op);
    a.create = pinRow(a.create, tenantId, model, op);
    if (isPlain(a.update) && a.update.tenantId !== undefined && a.update.tenantId !== tenantId) throw new TenantScopeViolation(model, op);
  }
  if (DATA_OPS.has(op)) {
    a.data = Array.isArray(a.data) ? a.data.map((r) => pinRow(r, tenantId, model, op)) : pinRow(a.data, tenantId, model, op);
  }
  if (op.startsWith('update') && isPlain(a.data) && a.data.tenantId !== undefined && a.data.tenantId !== tenantId) {
    throw new TenantScopeViolation(model, op);
  }
  return a;
}

export function tenantScopeGuardEnabled(): boolean {
  return process.env.TENANT_SCOPE_GUARD !== 'off';
}

/** Wraps a transaction client so tenant-scoped delegates enforce the active tenant. Other members pass through untouched. */
export function guardTenantClient<T extends object>(tx: T, tenantId: string): T {
  if (!tenantId) throw new Error('A normalized tenant context is required');
  const scoped = tenantScopedDelegates();
  const delegates = new Map<string, unknown>();
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !scoped.has(prop) || typeof value !== 'object' || value === null) return value;
      let wrapped = delegates.get(prop);
      if (!wrapped) {
        wrapped = new Proxy(value as object, {
          get(delegate, op) {
            const fn = Reflect.get(delegate, op, delegate);
            if (typeof op !== 'string' || typeof fn !== 'function' || !(WHERE_OPS.has(op) || DATA_OPS.has(op))) return typeof fn === 'function' ? fn.bind(delegate) : fn;
            return (args?: unknown) => (fn as (a: unknown) => unknown).call(delegate, guardArgs(prop, op, args, tenantId));
          },
        });
        delegates.set(prop, wrapped);
      }
      return wrapped;
    },
  });
}
