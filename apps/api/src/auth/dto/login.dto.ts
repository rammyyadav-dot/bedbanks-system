import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;

  /** Opt-in longer session on a trusted personal device (ADR 0091). Absent means the standard session. */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
