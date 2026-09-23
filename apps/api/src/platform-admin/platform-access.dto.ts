import { IsArray, IsOptional, IsString, Matches, MinLength } from 'class-validator'

export class CreatePlatformRoleDto {
  @IsString()
  @Matches(/^[a-z0-9._-]+$/)
  id!: string

  @IsString()
  @MinLength(1)
  name!: string

  @IsOptional()
  @IsString()
  description?: string
}

export class SetRolePermissionsDto {
  @IsArray()
  @IsString({ each: true })
  permissionIds!: string[]
}

export class AssignPlatformRoleDto {
  @IsString()
  userId!: string

  @IsString()
  roleId!: string
}
