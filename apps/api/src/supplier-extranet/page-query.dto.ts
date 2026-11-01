import { Type } from 'class-transformer'
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator'

/** Query of the paged extranet lists. `limit` is 1-50 (default 25). */
export class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number
  @IsOptional() @IsString() @Length(1, 700) cursor?: string
}
