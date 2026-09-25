import { IsIn } from 'class-validator'
import type { DashboardRange } from '../admin-dashboard.service'

export class DashboardQueryDto {
  @IsIn(['7d', '30d', '90d'])
  range: DashboardRange = '7d'
}
