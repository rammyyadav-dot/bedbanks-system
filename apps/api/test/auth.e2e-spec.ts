import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { hashPassword } from '../src/auth/utils/password';
import { hashSessionToken } from '../src/auth/utils/session-token';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';

/** Real Nest HTTP stack; database double. This is NOT PostgreSQL integration. */
describe('auth HTTP integration', () => {
  let app: INestApplication;
  let passwordHash: string;
  const sessions = new Map<string, { id: string; tokenHash: string; expiresAt: Date; revokedAt: Date | null }>();
  const user = () => ({ id: 'u1', email: 'admin@example.test', name: 'Admin', status: 'ACTIVE', passwordHash });
  const db = {
    user: { findUnique: jest.fn(async () => user()), update: jest.fn(async () => user()) },
    membership: { findMany: jest.fn(async () => []) },
    session: {
      create: jest.fn(async ({ data }) => { const row = { ...data, id: 's1', revokedAt: null }; sessions.set(data.tokenHash, row); return row; }),
      findUnique: jest.fn(async ({ where }) => { const row = sessions.get(where.tokenHash); return row ? { ...row, user: user() } : null; }),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async ({ where, data }) => { const row = sessions.get(where.tokenHash); if (row) row.revokedAt = data.revokedAt; return { count: row ? 1 : 0 }; }),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  beforeAll(async () => {
    passwordHash = await hashPassword('correct-password');
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(db).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  }, 15000);
  afterAll(async () => { await app?.close(); });
  const login = () => request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email: 'admin@example.test', password: 'correct-password' });
  it('sets secure opaque cookie, authenticates, revokes and prevents replay', async () => {
    const response = await login().expect(200);
    const setCookie = response.headers['set-cookie'][0];
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(response.headers['cache-control']).toBe('no-store');
    const cookie = setCookie.split(';')[0];
    const raw = cookie.split('=')[1];
    expect(response.text).not.toContain(raw);
    expect(response.text).not.toContain(passwordHash);
    expect(sessions.has(hashSessionToken(raw))).toBe(true);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    const logout = await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Origin', 'http://localhost:3001').set('Cookie', cookie).expect(200);
    expect(logout.headers['set-cookie'][0]).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(logout.headers['set-cookie'][0]).toContain('Secure');
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Origin', 'http://localhost:3001').set('Cookie', cookie).expect(200);
  });
  it('rejects missing, forged and malformed cookies', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', 'fbeds_session=forged').expect(401);
  });
  it('rejects missing and hostile mutation origins', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({}).expect(403);
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Origin', 'https://evil.example').expect(403);
  });
  it('rejects injected identity fields', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email: 'admin@example.test', password: 'correct-password', userId: 'other' }).expect(400);
  });
  it('registers the agent session guard in the full application', async () => {
    await request(app.getHttpServer()).get('/api/v1/agent/context').expect(401);
    await request(app.getHttpServer()).post('/api/v1/agent/offers/offer-a/hold').send({
      searchId: 'search-a', expectedCurrency: 'AED', expectedSellAmountMinor: 1000, idempotencyKey: 'request-123',
    }).expect(401);
  });
});
