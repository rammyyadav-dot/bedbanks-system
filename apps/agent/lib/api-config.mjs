// Only the public URL of the Agent API belongs in a NEXT_PUBLIC variable.
export const agentApiBase = (process.env.NEXT_PUBLIC_AGENT_API_URL ?? 'http://localhost:3001/api/v1').replace(/\/$/, '')
