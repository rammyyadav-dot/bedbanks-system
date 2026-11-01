// Shared presentational types for the FBEDS Admin console.
// Domain records come from authoritative API contracts; nothing here models mock data.

export type Status = 'active' | 'inactive' | 'pending' | 'suspended';
export type HealthState = 'healthy' | 'degraded' | 'down';

export interface SystemStatus {
  name: string;
  state: HealthState;
  detail: string;
}
