import { guardTenantClient, TenantScopeViolation, tenantScopedDelegates } from './tenant-scope-guard';

const A = 'tenant-a';
const B = 'tenant-b';

function fakeTx() {
  const calls: Array<{ model: string; op: string; args: any }> = [];
  const delegate = (model: string) =>
    new Proxy({}, { get: (_t, op: string) => (args: unknown) => { calls.push({ model, op, args }); return Promise.resolve(args); } });
  const tx: any = { ledgerEntry: delegate('ledgerEntry'), wallet: delegate('wallet'), user: delegate('user'), $executeRaw: () => 1 };
  return { tx, calls };
}

describe('tenant scope guard', () => {
  it('treats ledger and wallet as tenant-scoped', () => {
    expect(tenantScopedDelegates().has('ledgerEntry')).toBe(true);
    expect(tenantScopedDelegates().has('wallet')).toBe(true);
  });

  it('pins the tenant on reads that forgot it', async () => {
    const { tx, calls } = fakeTx();
    await guardTenantClient(tx, A).ledgerEntry.findMany({ where: { walletId: 'w1' } });
    await guardTenantClient(tx, A).ledgerEntry.findUnique({ where: { id: 'e1' } });
    await guardTenantClient(tx, A).ledgerEntry.count();
    expect(calls.map((c) => c.args.where)).toEqual([{ walletId: 'w1', tenantId: A }, { id: 'e1', tenantId: A }, { tenantId: A }]);
  });

  it('pins the tenant on updates, deletes and upserts', async () => {
    const { tx, calls } = fakeTx();
    const t = guardTenantClient(tx, A);
    await t.wallet.update({ where: { id: 'w' }, data: { currency: 'AED' } });
    await t.wallet.deleteMany({ where: { id: 'w' } });
    await t.ledgerEntry.upsert({ where: { id: 'e' }, create: { walletId: 'w' }, update: {} });
    expect(calls[0].args.where).toEqual({ id: 'w', tenantId: A });
    expect(calls[1].args.where).toEqual({ id: 'w', tenantId: A });
    expect(calls[2].args.where.tenantId).toBe(A);
    expect(calls[2].args.create.tenantId).toBe(A);
  });

  it('injects tenantId into create and createMany data', async () => {
    const { tx, calls } = fakeTx();
    const t = guardTenantClient(tx, A);
    await t.ledgerEntry.create({ data: { walletId: 'w' } });
    await t.ledgerEntry.createMany({ data: [{ walletId: 'w1' }, { walletId: 'w2' }] });
    expect(calls[0].args.data.tenantId).toBe(A);
    expect(calls[1].args.data.map((r: any) => r.tenantId)).toEqual([A, A]);
  });

  it('refuses another tenant in where, data, update data and upsert', () => {
    const t = guardTenantClient(fakeTx().tx, A);
    expect(() => t.ledgerEntry.findMany({ where: { tenantId: B } })).toThrow(TenantScopeViolation);
    expect(() => t.ledgerEntry.create({ data: { tenantId: B } })).toThrow(TenantScopeViolation);
    expect(() => t.ledgerEntry.createMany({ data: [{ tenantId: A }, { tenantId: B }] })).toThrow(TenantScopeViolation);
    expect(() => t.wallet.update({ where: { id: 'w' }, data: { tenantId: B } })).toThrow(TenantScopeViolation);
    expect(() => t.ledgerEntry.upsert({ where: { id: 'e' }, create: {}, update: { tenantId: B } })).toThrow(TenantScopeViolation);
    expect(() => t.ledgerEntry.findMany({ where: { tenantId: { in: [A, B] } } })).toThrow(TenantScopeViolation);
  });

  it('keeps the same tenant and leaves checked-create relations and non-tenant models alone', async () => {
    const { tx, calls } = fakeTx();
    const t = guardTenantClient(tx, A);
    await t.ledgerEntry.findMany({ where: { tenantId: A } });
    await t.ledgerEntry.create({ data: { tenant: { connect: { id: A } } } });
    await t.user.findMany({ where: { id: 'u' } });
    expect(calls[0].args.where).toEqual({ tenantId: A });
    expect(calls[1].args.data).toEqual({ tenant: { connect: { id: A } } });
    expect(calls[2].args.where).toEqual({ id: 'u' });
  });

  it('passes raw SQL and unknown members through', () => {
    const { tx } = fakeTx();
    expect(guardTenantClient(tx, A).$executeRaw()).toBe(1);
  });
});
