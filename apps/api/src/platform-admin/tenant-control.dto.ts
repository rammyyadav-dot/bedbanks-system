import { Type } from 'class-transformer'
import { IsArray, IsBoolean, IsDefined, ArrayMaxSize, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator'
import type { TenantBusiness } from '@bedbanks/contracts'
export class TenantDirectoryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string
  @IsOptional() @IsIn(['ACTIVE','SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED'
  @IsOptional() @IsIn(['BUYER','SUPPLIER','HYBRID']) classification?: string
  @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string
  @IsOptional() @IsISO8601() createdFrom?: string
  @IsOptional() @IsISO8601() createdTo?: string
  @IsOptional() @IsIn(['name','createdAt']) sort?: 'name' | 'createdAt'
  @IsOptional() @IsIn(['asc','desc']) order?: 'asc' | 'desc'
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25
}
export class TenantBusinessDto implements TenantBusiness {
  @IsString() @MinLength(2) @MaxLength(160) name!: string
  @IsOptional() @IsString() @MaxLength(160) tradingName?: string
  @IsIn(['BUYER','SUPPLIER','HYBRID']) classification!: TenantBusiness['classification']
  @Matches(/^[A-Z]{2}$/) country!: string
  @IsString() @MinLength(2) @MaxLength(300) address!: string
  @IsString() @MinLength(1) @MaxLength(100) city!: string
  @IsOptional() @IsString() @MaxLength(100) province?: string
  @IsOptional() @IsString() @MaxLength(30) postalCode?: string
  @IsOptional() @Matches(/^$|^https?:\/\/[^\s]+$/) @MaxLength(250) website?: string
  @IsEmail() @MaxLength(200) businessEmail!: string
  @IsOptional() @IsString() @MaxLength(40) phone?: string
  @IsString() @MinLength(1) @MaxLength(100) registrationNumber!: string
  @IsOptional() @IsString() @MaxLength(100) taxNumber?: string
  @Matches(/^[A-Z]{3}$/) currency!: string
  @IsArray() @ArrayMaxSize(100) @Matches(/^[A-Z]{2}$/, { each: true }) markets!: string[]
  @IsArray() @ArrayMaxSize(10) @IsIn(['B2B'], { each: true }) channels!: string[]
  @IsOptional() @IsString() @MaxLength(100) markupPolicyReference?: string
  @IsBoolean() financeReviewed!: boolean
}
export class CreateTenantDto {
  @Matches(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/) @MaxLength(80) slug!: string
  @IsDefined() @ValidateNested() @Type(() => TenantBusinessDto) business!: TenantBusinessDto
  @IsEmail() administratorEmail!: string
}
export class UpdateTenantProfileDto {
  @IsDefined() @ValidateNested() @Type(() => TenantBusinessDto) business!: TenantBusinessDto
  @IsInt() @Min(0) version!: number
}
export class MembershipChangeDto {
  @IsEmail() email!: string
  @IsIn(['owner','member','revoke']) role!: 'owner' | 'member' | 'revoke'
  @IsInt() @Min(0) version!: number
}
export class LifecycleRequestDto {
  @IsIn(['ACTIVE','SUSPENDED']) status!: 'ACTIVE' | 'SUSPENDED'
  @IsString() @MinLength(3) @MaxLength(500) reason!: string
  @IsInt() @Min(0) version!: number
}
export class LifecycleDecisionDto {
  @IsIn(['APPROVED','REJECTED']) decision!: 'APPROVED' | 'REJECTED'
  @IsString() @MinLength(3) @MaxLength(500) reason!: string
}
export class ComplianceDecisionDto {
  @IsIn(['APPROVED','REJECTED']) decision!: 'APPROVED' | 'REJECTED'
  @IsInt() @Min(1) version!: number
  @IsString() @MinLength(3) @MaxLength(500) reason!: string
}
export class TenantAuditDto {
  @IsOptional() @IsString() @MaxLength(100) actor?: string
  @IsOptional() @IsString() @MaxLength(100) action?: string
  @IsOptional() @IsString() @MaxLength(100) entityType?: string
  @IsOptional() @IsISO8601() from?: string
  @IsOptional() @IsISO8601() to?: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1
}
