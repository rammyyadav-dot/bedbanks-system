// FBEDS Admin Console — shared UI types.
// Local to apps/admin on purpose (spec section 13): these model mock UI
// state today and the exact same shapes /api/v1 will return later, so
// swapping lib/data's implementation won't require touching any page.

export type Status = 'active' | 'inactive' | 'pending' | 'suspended';
export type HealthState = 'healthy' | 'degraded' | 'down';

export interface Tenant {
  id: string;
  name: string;
  code: string;
  tier: 'Platform' | 'Gold' | 'Silver' | 'Bronze' | 'VIP';
  plan: string;
  users: number;
  status: Status;
  createdAt: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  tenantId: string;
  tenantName: string;
  role: string;
  status: Status;
  lastActive: string;
  createdAt: string;
}

export interface Permission {
  id: string;
  resource: string;
  actions: ('read' | 'create' | 'edit' | 'delete')[];
}

export interface Role {
  id: string;
  name: string;
  description: string;
  userCount: number;
  permissions: Permission[];
  status: Status;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  tenant: string;
  action: string;
  resource: string;
  resourceId: string;
  requestId: string;
  status: 'success' | 'failed';
  metadata: Record<string, string>;
}

export interface Hotel {
  id: string;
  name: string;
  code: string;
  destination: string;
  country: string;
  stars: number;
  supplier: string;
  status: Status;
  updatedAt: string;
}

export interface Room {
  id: string;
  hotelId: string;
  hotelName: string;
  type: string;
  occupancy: string;
  bedType: string;
  mealPlan: string;
  supplier: string;
  status: Status;
}

export interface Supplier {
  id: string;
  name: string;
  type: 'API' | 'XML' | 'DMC' | 'Manual';
  connection: HealthState;
  hotels: number;
  lastSync: string;
  successRate: number;
  status: Status;
}

export interface Contract {
  id: string;
  supplier: string;
  name: string;
  validFrom: string;
  validTo: string;
  currency: string;
  markup: number;
  commission: number;
  status: Status;
}

export interface InventoryRow {
  id: string;
  hotel: string;
  room: string;
  date: string;
  allotment: number;
  available: number;
  stopSell: boolean;
  release: number;
  status: Status;
}

export interface RateRow {
  id: string;
  hotel: string;
  room: string;
  mealPlan: string;
  date: string;
  supplierCost: number;
  markup: number;
  sellRate: number;
  currency: string;
  status: Status;
}

export interface SupplierSearchResult {
  supplier: string;
  responseMs: number;
  results: number;
  mapped: number;
  deduplicated: number;
  priced: number;
  status: 'ok' | 'slow' | 'error';
}

export interface Booking {
  id: string;
  reference: string;
  tenant: string;
  agent: string;
  hotel: string;
  checkIn: string;
  checkOut: string;
  supplier: string;
  amount: number;
  currency: string;
  status: 'confirmed' | 'pending' | 'failed' | 'cancelled';
  createdAt: string;
  guest?: string;
  supplierReference?: string;
  cost?: number;
  margin?: number;
}

export interface CancellationRow {
  id: string;
  booking: string;
  hotel: string;
  guest: string;
  deadline: string;
  penalty: number;
  refund: number;
  status: Status;
}

export interface Wallet {
  tenantId: string;
  tenant: string;
  availableCredit: number;
  usedCredit: number;
  limit: number;
  currency: string;
  status: Status;
}

export interface LedgerEntry {
  id: string;
  date: string;
  tenant: string;
  reference: string;
  type: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface Payment {
  id: string;
  reference: string;
  tenant: string;
  amount: number;
  currency: string;
  method: string;
  status: 'success' | 'pending' | 'failed';
  date: string;
}

export interface EmailLog {
  id: string;
  messageId: string;
  event: string;
  recipient: string;
  subject: string;
  status: 'delivered' | 'bounced' | 'pending';
  sentAt: string;
  provider: string;
}

export interface SystemStatus {
  name: string;
  state: HealthState;
  detail: string;
}
