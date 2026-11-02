import { routes } from '@bedbanks/contracts/agent'
import type { AuthenticatedUser, LoginRequest } from '@bedbanks/types'
import { createHttpClient, type HttpClientOptions } from './http'

export { ApiClientError, createHttpClient, unwrapEnvelope } from './http'
export { domainRoutes } from '@bedbanks/types'

export const agentPaths = routes.agent
export const authPaths = routes.auth

export type AgentHttp = ReturnType<typeof createHttpClient>

export function createAgentClient(options: HttpClientOptions) {
  const http = createHttpClient(options)
  return {
    ...http,
    login(body: LoginRequest) {
      return http.request<AuthenticatedUser>(routes.auth.login, { method: 'POST', body: JSON.stringify(body) })
    },
    logout() {
      return http.request<{ loggedOut: boolean }>(routes.auth.logout, { method: 'POST' })
    },
    me() {
      return http.request<AuthenticatedUser>(routes.auth.me)
    },
  }
}
