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
});
