import { NextResponse } from 'next/server'

// Load balancer liveness probe (ADR 0040). Deliberately has no database or API dependency: a brief database blip must not make the
// load balancer pull every portal task out of rotation. Readiness of the data layer is the API's own /api/v1/health/ready.
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
