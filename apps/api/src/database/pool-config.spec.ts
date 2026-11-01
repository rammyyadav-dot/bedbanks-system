import { assessConnectionBudget, inspectPoolConfig } from './pool-config';

describe('inspectPoolConfig', () => {
  it('accepts an explicit connection_limit', () => {
    const report = inspectPoolConfig('postgresql://u:p@db.internal:5432/fbeds?connection_limit=5');
    expect(report).toEqual({ connectionLimit: 5, pooledHost: false, warnings: [] });
  });

  it('warns when connection_limit is missing', () => {
    const report = inspectPoolConfig('postgresql://u:p@db.internal:5432/fbeds');
    expect(report.connectionLimit).toBeNull();
    expect(report.warnings).toHaveLength(1);
  });

  it('warns on an invalid connection_limit', () => {
    expect(inspectPoolConfig('postgresql://u:p@db.internal/fbeds?connection_limit=0').warnings[0]).toMatch(/positive integer/);
    expect(inspectPoolConfig('postgresql://u:p@db.internal/fbeds?connection_limit=abc').warnings[0]).toMatch(/positive integer/);
  });

  it('requires pgbouncer=true on a Neon pooled endpoint', () => {
    const missing = inspectPoolConfig('postgresql://u:p@ep-x-pooler.eu.aws.neon.tech/fbeds?connection_limit=5');
    expect(missing.pooledHost).toBe(true);
    expect(missing.warnings).toHaveLength(1);
    const ok = inspectPoolConfig('postgresql://u:p@ep-x-pooler.eu.aws.neon.tech/fbeds?connection_limit=5&pgbouncer=true');
    expect(ok.warnings).toEqual([]);
  });

  it('never echoes the URL, host or password in a finding', () => {
    const report = inspectPoolConfig('postgresql://app:secret-password@ep-x-pooler.internal.example/fbeds');
    expect(JSON.stringify(report.warnings)).not.toMatch(/secret-password|internal\.example/);
  });

  it('handles an absent or unparseable URL without throwing', () => {
    expect(inspectPoolConfig(undefined).warnings).toEqual([]);
    expect(inspectPoolConfig('not a url').warnings).toHaveLength(1);
  });
});

describe('assessConnectionBudget', () => {
  const base = { tasks: 4, maxConnections: 100, reserved: 10 };
  const url = (limit?: number) => `postgresql://u:secret-pw@db.internal:5432/fbeds${limit ? `?connection_limit=${limit}` : ''}`;

  it('is within budget when tasks x sum of limits fits', () => {
    const report = assessConnectionBudget({ ...base, urls: { API: url(10), BOOKING_OPS: url(5) } });
    expect(report).toMatchObject({ verdict: 'WITHIN_BUDGET', perTask: 15, worstCase: 60, available: 90 });
  });

  it('accepts exactly the available connections', () => {
    expect(assessConnectionBudget({ ...base, tasks: 3, urls: { API: url(30) } }).verdict).toBe('WITHIN_BUDGET');
  });

  it('is over budget when the worst case exceeds what is available', () => {
    const report = assessConnectionBudget({ ...base, urls: { API: url(20), BOOKING_OPS: url(5) } });
    expect(report.verdict).toBe('OVER_BUDGET');
    expect(report.worstCase).toBe(100);
    expect(report.findings[0]).toMatch(/exceeds the 90/);
  });

  it('is unproven, not within budget, when a pool has no explicit limit', () => {
    const report = assessConnectionBudget({ ...base, urls: { API: url(5), HOLD_EXPIRY: url() } });
    expect(report.verdict).toBe('UNPROVEN');
    expect(report.findings.join(' ')).toMatch(/HOLD_EXPIRY/);
  });

  it('skips unset URLs and is unproven when none remain', () => {
    expect(assessConnectionBudget({ ...base, urls: { API: undefined, X: '' } }).verdict).toBe('UNPROVEN');
    expect(assessConnectionBudget({ ...base, urls: { API: url(5), X: undefined } }).pools).toHaveLength(1);
  });

  it('rejects non-integer inputs and a reserve that consumes everything', () => {
    expect(assessConnectionBudget({ ...base, tasks: 0, urls: { API: url(5) } }).verdict).toBe('UNPROVEN');
    expect(assessConnectionBudget({ ...base, tasks: 2.5, urls: { API: url(5) } }).verdict).toBe('UNPROVEN');
    expect(assessConnectionBudget({ ...base, reserved: 100, urls: { API: url(5) } }).findings.join(' ')).toMatch(/no connections available/);
  });

  it('never echoes a URL, host or password', () => {
    const report = assessConnectionBudget({ ...base, urls: { API: url(), BAD: 'not a url' } });
    expect(JSON.stringify(report)).not.toMatch(/secret-pw|db\.internal/);
  });
});
