import { Type } from 'class-transformer'
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator'
import { AGENT_REF_MAX, CONFIRMATION_CC_MAX, GUEST_TITLES, SPECIAL_REQUEST_CODES, SPECIAL_REQUEST_NOTE_MAX } from '@bedbanks/contracts'
import { enabledSettlementCurrencies } from './currency'

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
  @IsOptional() @IsString() @Length(0, 500) reason?: string
}

export class OfferHoldDto {
  @IsString() @Length(1, 512) searchId!: string
  @IsIn(enabledSettlementCurrencies() as unknown as string[]) expectedCurrency!: string
  @IsInt() @Min(1) expectedSellAmountMinor!: number
  @IsString() @Length(8, 128) @Matches(/^[A-Za-z0-9._:-]+$/) idempotencyKey!: string
}

export class OfferHoldParamsDto {
  @IsString() @Length(1, 512) offerId!: string
}

export class OfferRecheckDto {
  @IsString() @Length(1, 512) offerId!: string
  @IsString() @Length(1, 512) searchId!: string
  @IsIn(enabledSettlementCurrencies() as unknown as string[]) expectedCurrency!: string
  @IsInt() @Min(1) expectedSellAmountMinor!: number
}

export class ReconcileBookingsDto {
  @IsOptional() @IsBoolean() dryRun?: boolean
  @IsOptional() @IsInt() @Min(5) @Max(1440) staleMinutes?: number
  @IsOptional() @IsInt() @Min(15) @Max(10080) prebookMaxMinutes?: number
}

export class CheckoutGuestDto {
  @IsInt() @Min(1) @Max(8) roomNumber!: number
  @IsIn(['ADULT', 'CHILD']) type!: 'ADULT' | 'CHILD'
  @IsOptional() @IsIn(GUEST_TITLES as unknown as string[]) title?: typeof GUEST_TITLES[number]
  @IsString() @Length(1, 80) firstName!: string
  @IsString() @Length(1, 80) lastName!: string
  @IsOptional() @IsInt() @Min(0) @Max(17) age?: number
}

export class SpecialRequestsDto {
  @IsArray() @ArrayMaxSize(SPECIAL_REQUEST_CODES.length) @IsIn(SPECIAL_REQUEST_CODES as unknown as string[], { each: true }) codes!: typeof SPECIAL_REQUEST_CODES[number][]
  @IsOptional() @IsString() @MaxLength(SPECIAL_REQUEST_NOTE_MAX) note?: string
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
  /** ADR 0066: every guest by room. Validated against the held occupancy by normalizeCheckout. */
  @IsOptional() @IsArray() @ArrayMaxSize(48) @ValidateNested({ each: true }) @Type(() => CheckoutGuestDto) guests?: CheckoutGuestDto[]
  @IsOptional() @IsString() @MaxLength(AGENT_REF_MAX) agentRef?: string
  @IsOptional() @ValidateNested() @Type(() => SpecialRequestsDto) specialRequests?: SpecialRequestsDto
  /** Required (true) when booking is enabled: the agent accepted the cancellation policy and booking terms. */
  @IsOptional() @IsBoolean() termsAccepted?: boolean
}

export class ConfirmBookingDto {
  @IsString() @Length(1, 128) bookingId!: string
  /** ADR 0066: up to three CC addresses for the confirmation email. */
  @IsOptional() @IsArray() @ArrayMaxSize(CONFIRMATION_CC_MAX) @IsString({ each: true }) @MaxLength(254, { each: true }) ccEmails?: string[]
}
