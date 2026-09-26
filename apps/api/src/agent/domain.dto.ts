import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator'
import { SUPPORTED_SETTLEMENT_CURRENCIES } from './currency'

export class RateActionDto {
  @IsString() hotelId!: string
  @IsString() rateId!: string
  @IsString() idempotencyKey!: string
  @IsInt() @Min(0) totalMinor!: number
  @IsString() currency!: string
  @IsOptional() @IsString() supplierReference?: string
}

export class BookingActionDto extends RateActionDto {
  @IsOptional() @IsString() guestName?: string
}

export class CancellationDto {
  @IsOptional() @IsString() reason?: string
}

export class OfferHoldDto {
  @IsString() @Length(1, 512) searchId!: string
  @IsIn(SUPPORTED_SETTLEMENT_CURRENCIES) expectedCurrency!: string
  @IsInt() @Min(1) expectedSellAmountMinor!: number
  @IsString() @Length(8, 128) @Matches(/^[A-Za-z0-9._:-]+$/) idempotencyKey!: string
}

export class OfferHoldParamsDto {
  @IsString() @Length(1, 512) offerId!: string
}

export class OfferRecheckDto {
  @IsString() @Length(1, 512) offerId!: string
  @IsString() @Length(1, 512) searchId!: string
  @IsIn(SUPPORTED_SETTLEMENT_CURRENCIES) expectedCurrency!: string
  @IsInt() @Min(1) expectedSellAmountMinor!: number
}
