export const TENANT_SETTING_LANGUAGES = ['en', 'ar', 'fr', 'de', 'es', 'hi'] as const
export type TenantSettingLanguage = (typeof TENANT_SETTING_LANGUAGES)[number]

export const TENANT_SETTING_TIME_ZONES = [
  'UTC',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Europe/London',
  'America/New_York',
  'Asia/Singapore',
  'Australia/Sydney',
] as const
export type TenantSettingTimeZone = (typeof TENANT_SETTING_TIME_ZONES)[number]

export const TENANT_SETTING_CURRENCIES = [
  'AED', 'USD', 'EUR', 'INR', 'GBP', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'SGD', 'AUD', 'CAD', 'JPY',
] as const
export type TenantSettingCurrency = (typeof TENANT_SETTING_CURRENCIES)[number]

export interface MoneyMinor {
  amountMinor: string
  currency: string
}

export interface TenantSettingsView {
  tenantId: string
  name: string
  slug: string
  status: string
  supportEmail: string | null
  defaultLanguage: TenantSettingLanguage
  timeZone: TenantSettingTimeZone
  defaultCurrency: TenantSettingCurrency
  lowBalanceThreshold: MoneyMinor
  updatedAt: string
}

export interface UpdateTenantSettingsRequest {
  name: string
  supportEmail: string | null
  defaultLanguage: TenantSettingLanguage
  timeZone: TenantSettingTimeZone
  defaultCurrency: TenantSettingCurrency
  lowBalanceThreshold: MoneyMinor
}
