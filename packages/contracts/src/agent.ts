// The Agent portal's contract surface (ADR 0075). The Agent imports `@bedbanks/contracts/agent`, never the root barrel, so its
// browser bundle carries no Admin, supply, platform or supplier contract (permission catalogue, department map, routes).
import { agentRoutes, authRoutes } from './agent-routes'

export const routes = { auth: authRoutes, agent: agentRoutes } as const

export * from './envelope'
export * from './agent-checkout'
export * from './agent-search'
export type { AgentFundingReceiptView, AgentFundingView, FundingDeclareRequest, FundingMethod, FundingPayerType, FundingReceiptStatus } from './funding'
