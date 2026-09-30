import { Type } from 'class-transformer'
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator'
import { TENANT_SETTING_CURRENCIES, TENANT_SETTING_LANGUAGES, TENANT_SETTING_TIME_ZONES } from '@bedbanks/contracts'

export class SettingsQueryDto {}

export class LowBalanceThresholdDto {
  @Matches(/^\d+$/)
  amountMinor!: string

  @IsIn([...TENANT_SETTING_CURRENCIES])
  currency!: string
}

export class UpdateTenantSettingsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string

  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsEmail()
  supportEmail?: string | null

  @IsIn([...TENANT_SETTING_LANGUAGES])
  defaultLanguage!: (typeof TENANT_SETTING_LANGUAGES)[number]

  @IsIn([...TENANT_SETTING_TIME_ZONES])
  timeZone!: (typeof TENANT_SETTING_TIME_ZONES)[number]

  @IsIn([...TENANT_SETTING_CURRENCIES])
  defaultCurrency!: (typeof TENANT_SETTING_CURRENCIES)[number]

  @ValidateNested()
  @Type(() => LowBalanceThresholdDto)
  lowBalanceThreshold!: LowBalanceThresholdDto
}
