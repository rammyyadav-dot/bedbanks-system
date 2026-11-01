import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Facts about the current HTTP request that audit records need but the services that write them do not receive.
 * `ip` is the address Express reports (`req.ip`). Behind a proxy that `trust proxy` does not cover it is the proxy's address, so it is
 * evidence, not identity; it is never used to authorise anything.
 */
export interface RequestContext { requestId: string; ip: string | null }

const storage = new AsyncLocalStorage<RequestContext>()

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T => storage.run(context, fn)
export const currentRequestContext = (): RequestContext | undefined => storage.getStore()
