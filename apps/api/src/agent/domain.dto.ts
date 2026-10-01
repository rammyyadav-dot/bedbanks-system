import { Type } from 'class-transformer'
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateNested } from 'class-validator'
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

export class ReconcileBookingsDto {
  @IsOptional() @IsBoolean() dryRun?: boolean
  @IsOptional() @IsInt() @Min(5) @Max(1440) staleMinutes?: number
}

export class LeadGuestDto {
  @IsString() @Length(1, 80) firstName!: string
  @IsString() @Length(1, 80) lastName!: string
}

export class PrebookBookingDto {
  @IsString() @Length(1, 128) inventoryHoldId!: string
  @IsString() @Length(8, 128) @Matches(/^[A-Za-z0-9._:-]+$/) idempotencyKey!: string
  @IsInt() @Min(1) @Max(8) adults!: number
  @IsInt() @Min(0) @Max(8) children!: number
  @IsArray() @ArrayMaxSize(8) @IsInt({ each: true }) @Min(0, { each: true }) @Max(17, { each: true }) childAges!: number[]
  @ValidateNested() @Type(() => LeadGuestDto) leadGuest!: LeadGuestDto
}

export class ConfirmBookingDto {
  @IsString() @Length(1, 128) bookingId!: string
}
