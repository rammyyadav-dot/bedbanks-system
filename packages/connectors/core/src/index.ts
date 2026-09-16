export type ConnectorCapability = 'search' | 'recheck' | 'prebook' | 'book' | 'cancel' | 'content' | 'availability' | 'webhook';
export interface ConnectorContext { tenantId: string; correlationId: string }
export interface ConnectorAdapter {
  readonly provider: string;
  readonly capabilities: readonly ConnectorCapability[];
  health(context: ConnectorContext): Promise<'healthy' | 'degraded' | 'unhealthy'>;
}
