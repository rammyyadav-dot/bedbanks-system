import { type ExecutionContext } from '@nestjs/common'
import { lastValueFrom, of } from 'rxjs'
import { ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import { TenantRlsInterceptor } from './tenant-rls.interceptor'
import { currentTenantId, TENANT_REQUIRED } from './tenant-session'

function context(request: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext
}

describe('TenantRlsInterceptor', () => {
  const interceptor = new TenantRlsInterceptor()

  it('exposes the guard tenant to Drizzle for the handler and clears it afterwards', async () => {
    let seen: string | undefined
    const result = await lastValueFrom(interceptor.intercept(
      context({ [ACTIVE_TENANT_REQUEST_KEY]: 'tenant-a' }),
      { handle: () => of(Promise.resolve().then(() => { seen = currentTenantId(); return 'ok' })) },
    ))
    expect(result).toBe('ok')
    expect(seen).toBe('tenant-a')
    expect(currentTenantId()).toBeUndefined()
  })

  it('leaves requests with no validated tenant outside the scope', async () => {
    let seen: string | undefined = 'unset'
    await lastValueFrom(interceptor.intercept(context({}), {
      handle: () => of(Promise.resolve().then(() => { seen = currentTenantId(); return 'ok' })),
    }))
    expect(seen).toBeUndefined()
  })

  it('does not accept a padded tenant id from the request', async () => {
    await expect(lastValueFrom(interceptor.intercept(
      context({ [ACTIVE_TENANT_REQUEST_KEY]: ' tenant-a' }),
      { handle: () => of('ok') },
    ))).rejects.toThrow(TENANT_REQUIRED)
    expect(currentTenantId()).toBeUndefined()
  })
})
