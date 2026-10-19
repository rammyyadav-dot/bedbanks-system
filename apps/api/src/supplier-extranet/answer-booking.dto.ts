import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'
import { EXTRANET_BOOKING_ANSWERS, type ExtranetBookingAnswer } from '@bedbanks/contracts'
import { EXTRANET_BOOKING_STATUSES } from './list-bookings.dto'

export class AnswerBookingDto {
  @IsIn(EXTRANET_BOOKING_ANSWERS) answer!: ExtranetBookingAnswer
  @IsIn(EXTRANET_BOOKING_STATUSES) expectedStatus!: (typeof EXTRANET_BOOKING_STATUSES)[number]
  @IsOptional() @IsString() @MaxLength(120) supplierRef?: string
  @IsOptional() @IsString() @MaxLength(120) hotelConfirmationNo?: string
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
