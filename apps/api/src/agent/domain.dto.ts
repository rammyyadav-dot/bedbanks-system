import { IsInt, IsOptional, IsString, Min } from 'class-validator'

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
