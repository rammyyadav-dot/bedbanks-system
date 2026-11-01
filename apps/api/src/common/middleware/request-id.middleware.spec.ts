import { RequestIdMiddleware, REQUEST_ID_HEADER } from './request-id.middleware'

function run(incoming?: string) {
  const headers: Record<string, string> = {}
  const req = { header: (name: string) => (name === REQUEST_ID_HEADER ? incoming : undefined) } as never as { requestId?: string; header: (n: string) => string | undefined }
  const res = { setHeader: (name: string, value: string) => { headers[name] = value } }
  let nextCalled = false
  new RequestIdMiddleware().use(req as never, res as never, () => { nextCalled = true })
  return { requestId: req.requestId, echoed: headers[REQUEST_ID_HEADER], nextCalled }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('RequestIdMiddleware', () => {
  it('reuses a safe caller id and echoes it', () => {
    expect(run('partner-req.2027:0001')).toEqual({ requestId: 'partner-req.2027:0001', echoed: 'partner-req.2027:0001', nextCalled: true })
  })

  it('generates a UUID when the header is absent or blank', () => {
    expect(run().requestId).toMatch(UUID)
    expect(run('   ').requestId).toMatch(UUID)
  })

  it.each([
    ['log forging', 'abcdefgh\nlevel=error msg=forged'],
    ['markup', '<script>alert(1)</script>'],
    ['oversized', 'a'.repeat(129)],
    ['too short to be unique', 'abc'],
    ['spaces', 'abc def ghi'],
  ])('replaces an unsafe caller id (%s) with a UUID', (_label, incoming) => {
    const { requestId, echoed } = run(incoming)
    expect(requestId).toMatch(UUID)
    expect(echoed).toBe(requestId)
  })
})
