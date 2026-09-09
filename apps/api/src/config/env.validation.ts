import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
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
  DATABASE_URL: string;
}

/**
 * Validates process.env against EnvironmentVariables at application
 * bootstrap. Throws (and stops startup) if anything required is missing
 * or malformed, instead of the app silently running with `undefined`
 * config values. This is intentionally minimal for P0-B — no
 * DATABASE_URL, no JWT secrets, no third-party API keys yet.
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

  return validatedConfig;
}
