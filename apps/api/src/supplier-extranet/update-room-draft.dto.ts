import { IsString, MaxLength, MinLength } from 'class-validator'

export class UpdateRoomDraftDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  supplierNotes!: string
}
