// Browser API calls are same-origin and proxied to the API by next.config.mjs (ADR 0010),
// so the session cookie stays host-only on the Agent origin. NEXT_PUBLIC_AGENT_API_URL is an
// explicit override for tests and tooling only; never place credentials in NEXT_PUBLIC_* variables.
export const agentApiBase = (process.env.NEXT_PUBLIC_AGENT_API_URL ?? '/api/v1').replace(/\/$/, '')
