import type { CoordinationPort, LockLease } from './cache.port'
import { runExclusive } from './single-runner'

const port = (acquire: CoordinationPort['acquire'], release: CoordinationPort['release'] = async () => undefined): CoordinationPort => ({ acquire, release })
const lease: LockLease = { key: 'k', token: 't' }

describe('runExclusive', () => {
  it('runs without coordination', async () => {
    expect(await runExclusive(null, 'k', 1000, async () => 7)).toEqual({ ran: true, result: 7, coordinated: false })
  })
  it('runs when it wins the lease and releases it afterwards, even if the work throws', async () => {
    const release = jest.fn(async () => undefined)
    expect(await runExclusive(port(async () => lease, release), 'k', 1000, async () => 1)).toEqual({ ran: true, result: 1, coordinated: true })
    await expect(runExclusive(port(async () => lease, release), 'k', 1000, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(release).toHaveBeenCalledTimes(2)
  })
  it('skips when another instance holds the lease, without running the work', async () => {
    const work = jest.fn(async () => 1)
    expect(await runExclusive(port(async () => null), 'k', 1000, work)).toEqual({ ran: false })
    expect(work).not.toHaveBeenCalled()
  })
  it('fails open when Redis is down, reporting only the error', async () => {
    const seen = jest.fn()
    const out = await runExclusive(port(async () => { throw new Error('ECONNREFUSED') }), 'k', 1000, async () => 'done', seen)
    expect(out).toEqual({ ran: true, result: 'done', coordinated: false })
    expect(seen).toHaveBeenCalledTimes(1)
  })
  it('a failing release never fails the pass', async () => {
    const out = await runExclusive(port(async () => lease, async () => { throw new Error('down') }), 'k', 1000, async () => 5)
    expect(out).toMatchObject({ ran: true, result: 5 })
  })
})
