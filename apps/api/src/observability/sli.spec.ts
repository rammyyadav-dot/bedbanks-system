import { buildSliRecord, formatSli } from './sli'

describe('SLI records', () => {
  it('classifies the journeys the staging objectives name', () => {
    expect(buildSliRecord({ method: 'POST', path: '/api/v1/auth/login', status: 401, durationMs: 12.4 })).toMatchObject({ signal: 'authentication', outcome: 'denied', durationMs: 12 })
    expect(buildSliRecord({ method: 'POST', baseUrl: '/api/v1/agent', routePath: '/search', status: 200, durationMs: 80 })).toMatchObject({ signal: 'search', outcome: 'ok' })
    expect(buildSliRecord({ method: 'POST', path: '/api/v1/agent/rates/recheck', status: 503, durationMs: 10 })).toMatchObject({ signal: 'recheck', outcome: 'server_error' })
    expect(buildSliRecord({ method: 'POST', path: '/api/v1/agent/bookings', status: 201, durationMs: 30 })).toMatchObject({ signal: 'booking', outcome: 'ok' })
    expect(buildSliRecord({ method: 'DELETE', path: '/api/v1/agent/bookings/:id', status: 200, durationMs: 15 })).toMatchObject({ signal: 'cancellation', outcome: 'ok' })
    expect(buildSliRecord({ method: 'GET', path: '/api/v1/admin/hotels', status: 403, durationMs: 4 })).toMatchObject({ signal: 'authorization', outcome: 'denied' })
  })

  it('skips health probes and refuses query strings, addresses and unsafe request ids', () => {
    expect(buildSliRecord({ method: 'GET', path: '/api/v1/health/ready', status: 200, durationMs: 1 })).toBeNull()
    const queried = buildSliRecord({ method: 'GET', path: '/api/v1/agent/search?q=guest@example.com', status: 200, durationMs: 1 })
    expect(queried).toMatchObject({ signal: 'search', outcome: 'ok' })
    expect(formatSli(queried!)).not.toContain('guest')
    expect(formatSli(queried!)).not.toContain('?')
    const line = formatSli(buildSliRecord({ method: 'POST', path: '/api/v1/agent/search', status: 200, durationMs: 5, requestId: 'bad id' })!)
    expect(line).not.toContain('requestId')
    expect(line).not.toContain('guest')
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line).event).toBe('ops.sli')
  })

  it('keeps a safe request id and caps duration', () => {
    expect(buildSliRecord({ method: 'POST', path: '/api/v1/agent/bookings', status: 200, durationMs: 9_999_999, requestId: 'req-12345678' })).toMatchObject({
      durationMs: 300_000,
      requestId: 'req-12345678',
    })
  })
})
