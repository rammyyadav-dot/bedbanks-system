import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator'
import { EXTRANET_CHANGE_SET_STATUSES, type ExtranetChangeSetStatus } from '@bedbanks/contracts'

export class CreateChangeSetDto {
  @IsString() @Length(1, 100) hotelId!: string
  @IsString() @Length(1, 90_000) csv!: string
}

export class ReplaceChangeSetDto {
  @IsString() @Length(1, 90_000) csv!: string
  @IsInt() @Min(1) @Max(1_000_000) expectedVersion!: number
}

export class ChangeSetTransitionDto {
  @IsInt() @Min(1) @Max(1_000_000) expectedVersion!: number
}

export class ListChangeSetsQueryDto {
  @IsOptional() @IsIn(EXTRANET_CHANGE_SET_STATUSES) status?: ExtranetChangeSetStatus
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number
  @IsOptional() @IsString() @MaxLength(300) cursor?: string
}
