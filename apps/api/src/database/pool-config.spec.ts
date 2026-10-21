import { inspectPoolConfig } from './pool-config';

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
