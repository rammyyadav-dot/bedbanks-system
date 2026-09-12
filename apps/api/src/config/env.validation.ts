import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  API_PORT: number = 3001;

  @IsString()
  @IsOptional()
  API_HOST: string = '0.0.0.0';

  @IsString()
  @IsOptional()
  API_PREFIX: string = 'api/v1';

  // Required, no default — a database URL can't have a generic safe
  // fallback the way a port number can. Startup should fail loudly
  // here rather than the app running and every query failing later.
  @IsUrl(
    { protocols: ['postgresql', 'postgres'], require_tld: false },
    { message: 'DATABASE_URL must be a valid postgresql:// connection string' },
  )
  DATABASE_URL!: string;

  // --- P0-D: authentication (opaque sessions) ---

  @IsInt()
  @Min(60, { message: 'AUTH_SESSION_TTL_SECONDS should be at least 60 seconds' })
  @IsOptional()
  AUTH_SESSION_TTL_SECONDS: number = 28800; // 8 hours

  @IsString()
  @IsOptional()
  AUTH_COOKIE_NAME: string = 'fbeds_session';

  // Env vars are strings — 'true'/'false', validated and parsed in
  // configuration.ts rather than as a real boolean here.
  @IsIn(['true', 'false'], { message: 'AUTH_COOKIE_SECURE must be exactly "true" or "false"' })
  @IsOptional()
  AUTH_COOKIE_SECURE: string = 'false';

  @IsIn(['lax', 'strict', 'none'])
  @IsOptional()
  AUTH_COOKIE_SAME_SITE: string = 'lax';

  // Explicit allowed origin for credentialed CORS — never combine
  // Access-Control-Allow-Origin: * with credentials: true.
  @IsUrl({ require_tld: false }, { message: 'ADMIN_ORIGIN must be a valid URL, e.g. http://localhost:3000' })
  @IsOptional()
  ADMIN_ORIGIN: string = 'http://localhost:3000';
}

/**
 * Validates process.env against EnvironmentVariables at application
 * bootstrap. Throws (and stops startup) if anything required is
 * missing or malformed, instead of the app silently running with
 * `undefined` config values. Covers process/API config (P0-B),
 * DATABASE_URL (P0-C), and session/cookie/CORS config (P0-D).
 */
export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const message = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Environment validation failed: ${message}`);
  }

  // Cross-field rule that a single field decorator can't express:
  // production must not silently run with a non-Secure cookie. This
  // is deliberately a hard failure, not a warning — an insecure
  // session cookie in production is a real vulnerability, not a style
  // preference.
  if (validatedConfig.NODE_ENV === Environment.Production && validatedConfig.AUTH_COOKIE_SECURE !== 'true') {
    throw new Error(
      'Refusing to start: NODE_ENV=production requires AUTH_COOKIE_SECURE=true. ' +
        'Running with an insecure session cookie in production is not permitted.',
    );
  }

  return validatedConfig;
}
