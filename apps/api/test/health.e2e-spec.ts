import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';

describe('FBEDS API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirror main.ts bootstrap exactly, so this test proves the same
    // configuration that actually runs in production.
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // Test 1 + Test 5: correct prefix, HTTP 200.
  it('GET /api/v1/health returns HTTP 200 with the api/v1 prefix applied', () => {
    return request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });

  // Test 2 + Test 3 + Test 4: success envelope, status "ok", correct
  // service name.
  it('GET /api/v1/health returns the standard success envelope', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('ok');
        expect(res.body.data.service).toBe('fbeds-api');
      });
  });

  it('echoes back a supplied X-Request-ID header', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Request-ID', 'test-request-id-123')
      .expect(200)
      .expect((res) => {
        expect(res.headers['x-request-id']).toBe('test-request-id-123');
      });
  });

  it('generates a request ID when none is supplied', () => {
    return request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect((res) => {
        expect(res.headers['x-request-id']).toBeDefined();
        expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
      });
  });

  it('a nonexistent route returns the standard error envelope with 404', () => {
    return request(app.getHttpServer())
      .get('/api/v1/this-route-does-not-exist')
      .expect(404)
      .expect((res) => {
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe('NOT_FOUND');
        expect(res.body.meta.path).toBe('/api/v1/this-route-does-not-exist');
        expect(res.body.meta.requestId).toBeDefined();
        // Never leak stack traces or internals.
        expect(res.body.error).not.toHaveProperty('stack');
      });
  });
});
