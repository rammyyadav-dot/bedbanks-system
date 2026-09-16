export type DateRange = '7d' | '30d' | '90d'
export type DashboardLoadState = 'idle' | 'loading' | 'success' | 'error'
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL'

export interface DashboardSummary {
  totalBookings: number | null
  grossBookingValue: MoneyValue | null
  netRevenue: MoneyValue | null
  activeSuppliers: number | null
  activeHotels: number | null
  systemHealth: HealthState | null
}

export interface MoneyValue { amount: number; currency: string }
export interface BookingActivityPoint { date: string; total: number; confirmed: number }
export interface RevenuePoint { date: string; gross: MoneyValue | null; net: MoneyValue | null }
export type HealthState = 'healthy' | 'degraded' | 'down' | 'unknown'
export interface SystemHealthItem { name: string; state: HealthState; detail?: string }
export interface RecentBooking { id: string; reference: string; agency: string; hotel: string; checkIn: string; checkOut: string; status: string; amount: MoneyValue | null }
export interface AdminAlert { id: string; severity: AlertSeverity; title: string; detail: string; createdAt: string }
export interface DestinationRanking { name: string; bookings: number; share: number }
export interface SupplierRanking { name: string; bookings: number; share: number }

export interface AdminDashboardView {
  range: DateRange
  generatedAt: string
  summary: DashboardSummary
  bookingActivity: BookingActivityPoint[]
  revenueOverview: RevenuePoint[]
  systemHealth: SystemHealthItem[]
  recentBookings: RecentBooking[]
  alerts: AdminAlert[]
  topDestinations: DestinationRanking[]
  topSuppliers: SupplierRanking[]
}

export interface DashboardQuery { range: DateRange }
