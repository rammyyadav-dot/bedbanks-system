import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator'

export const EXTRANET_BOOKING_STATUSES = ['PENDING_SUPPLIER', 'ON_REQUEST', 'CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'CANCELLED', 'CHECKED_OUT', 'NO_SHOW', 'REJECTED', 'FAILED'] as const

export class ListBookingsQueryDto {
  @IsOptional() @IsIn(EXTRANET_BOOKING_STATUSES) status?: (typeof EXTRANET_BOOKING_STATUSES)[number]
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) checkInFrom?: string
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) checkInTo?: string
  @IsOptional() @IsString() @Length(3, 40) @Matches(/^[A-Za-z0-9-]+$/) reference?: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number
  @IsOptional() @IsString() @Length(1, 300) cursor?: string
}
