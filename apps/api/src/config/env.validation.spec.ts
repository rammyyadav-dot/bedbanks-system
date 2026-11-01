import 'reflect-metadata';
import { validate } from './env.validation';
const base = { DATABASE_URL: 'postgresql://localhost:5432/fbeds_test' };
describe('authentication environment', () => {
  it('defaults to Secure cookies', () => expect(validate(base).AUTH_COOKIE_SECURE).toBe('true'));
  it.each(['development', 'staging', 'production'])('rejects insecure cookies in %s', (NODE_ENV) => {
    expect(() => validate({ ...base, NODE_ENV, AUTH_COOKIE_SECURE: 'false' })).toThrow();
  });
  it.each(['https://admin.example/path', 'https://admin.example/', '*', 'null'])('rejects non-origin %s', (ADMIN_ORIGIN) => {
    expect(() => validate({ ...base, ADMIN_ORIGIN })).toThrow();
  });
  it('requires HTTPS outside local development', () => expect(() => validate({ ...base, NODE_ENV: 'production' })).toThrow());
  it('accepts exact production HTTPS origin', () => expect(validate({ ...base, NODE_ENV: 'production', ADMIN_ORIGIN: 'https://admin.example' }).AUTH_COOKIE_SECURE).toBe('true'));
  describe('TRUSTED_ORIGINS', () => {
    const prod = { ...base, NODE_ENV: 'production', ADMIN_ORIGIN: 'https://admin.example' };
    it('is optional', () => expect(() => validate(prod)).not.toThrow());
    it('accepts a comma-separated list of exact HTTPS origins', () =>
      expect(() => validate({ ...prod, TRUSTED_ORIGINS: 'https://agent.example, https://supplier.example' })).not.toThrow());
    it.each(['https://agent.example/path', 'https://agent.example/', '*', 'null', 'agent.example', 'https://agent.example,*'])('rejects %s', (TRUSTED_ORIGINS) => {
      expect(() => validate({ ...prod, TRUSTED_ORIGINS })).toThrow('TRUSTED_ORIGINS');
    });
    it('requires HTTPS in production', () => expect(() => validate({ ...prod, TRUSTED_ORIGINS: 'http://agent.example' })).toThrow('HTTPS'));
    it('allows HTTP locally', () => expect(() => validate({ ...base, TRUSTED_ORIGINS: 'http://localhost:3003' })).not.toThrow());
  });
});
