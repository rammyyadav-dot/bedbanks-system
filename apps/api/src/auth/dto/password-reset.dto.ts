import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class PasswordResetRequestDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class PasswordResetConfirmDto {
  /** Same shape as a session token: 64 lowercase hex characters. */
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  token!: string;

  /** Length is checked again against the password policy in the service so the user gets a specific message. */
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  newPassword!: string;
}
