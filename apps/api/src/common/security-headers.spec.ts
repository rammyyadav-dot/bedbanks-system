import type { Request, Response } from 'express';
import { securityHeaders } from './security-headers';

function run(production: boolean, preset: Record<string, string> = {}, path = '/api/v1/health') {
  const headers = new Map<string, string>(Object.entries(preset));
  const res = {
    removeHeader: (name: string) => headers.delete(name),
    setHeader: (name: string, value: string) => headers.set(name, value),
    getHeader: (name: string) => headers.get(name),
  } as unknown as Response;
  const next = jest.fn();
  securityHeaders(production)({ path } as Request, res, next);
  return { headers, next };
}

describe('securityHeaders', () => {
  it('sets the baseline and continues the chain', () => {
    const { headers, next } = run(false);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.has('Strict-Transport-Security')).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('adds HSTS only in production', () => {
    expect(run(true).headers.get('Strict-Transport-Security')).toContain('max-age=63072000');
  });

  it('does not override a handler-chosen Cache-Control and strips X-Powered-By', () => {
    const { headers } = run(true, { 'Cache-Control': 'public, max-age=60', 'X-Powered-By': 'Express' });
    expect(headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(headers.has('X-Powered-By')).toBe(false);
  });

  it('leaves the Content-Security-Policy to Swagger on the docs path', () => {
    expect(run(false, {}, '/api/docs').headers.has('Content-Security-Policy')).toBe(false);
    expect(run(false).headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });
});
