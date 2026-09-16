export type SupplierType = 'HOTEL' | 'DMC' | 'CHANNEL_MANAGER'
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

export interface SupplierContext {
  id: string
  name: string
  type: SupplierType
  market: string
  onboardingProgress: number
}

export interface Metric {
  label: string
  value: string
  detail: string
  trend?: 'up' | 'down' | 'flat'
}

export interface Property {
  id: string
  supplierReference: string
  name: string
  destination: string
  country: string
  stars: number
  contentScore: number
  rooms: number
  contractStatus: string
  inventoryStatus: string
  mappingStatus: string
  lastUpdated: string
  status: string
}

export interface Booking {
  id: string
  property: string
  arrival: string
  departure: string
  room: string
  status: string
  payableMinor: number
  currency: string
}

export interface AlertItem {
  id: string
  title: string
  detail: string
  time: string
  tone: StatusTone
}

export interface SupplierDashboard {
  metrics: Metric[]
  properties: Property[]
  bookings: Booking[]
  alerts: AlertItem[]
}

export interface SupplierDataAdapter {
  getDashboard(): Promise<SupplierDashboard>
  listProperties(): Promise<Property[]>
  listBookings(): Promise<Booking[]>
}
