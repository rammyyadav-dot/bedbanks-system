import { UnprocessableEntityException } from '@nestjs/common'
import type { SearchCriteria } from '@bedbanks/domain'
import { AgentController } from './agent.controller'
import { uniformRoomStays } from './room-stays'

const stay = (adults: number, ages: number[] = []) => ({ adults, children: ages.map((age) => ({ age })) })
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const base: SearchCriteria = { destination: 'Dubai', checkIn: future(30), checkOut: future(33), rooms: 2, adults: 3, children: 0, childAges: [], nationality: 'IN', currency: 'AED' }

describe('uniformRoomStays', () => {
  it('accepts no per-room parties and identical parties, in any child order of equal ages', () => {
    expect(uniformRoomStays({})).toBe(true)
    expect(uniformRoomStays({ roomStays: [] })).toBe(true)
    expect(uniformRoomStays({ roomStays: [stay(2), stay(2)] })).toBe(true)
    expect(uniformRoomStays({ roomStays: [stay(2, [4, 9]), stay(2, [4, 9]), stay(2, [4, 9])] })).toBe(true)
  })

  it('rejects any difference in adults, child count or child age', () => {
    expect(uniformRoomStays({ roomStays: [stay(2), stay(1)] })).toBe(false)
    expect(uniformRoomStays({ roomStays: [stay(2), stay(2, [5])] })).toBe(false)
    expect(uniformRoomStays({ roomStays: [stay(2, [5]), stay(2, [6])] })).toBe(false)
  })
})

describe('AgentController.search with mixed room occupancies', () => {
  function controller(supplierName: string) {
    const execute = jest.fn()
    const none = {} as never
    const instance = new AgentController(
      { name: supplierName } as never, none, none, none, { execute } as never, none, none, none, none, none, none,
      { apply: async (_t: string, c: SearchCriteria) => c } as never, none, none,
    )
    return { instance, execute }
  }
  const request = { requestId: 'req-a', activeTenantId: 'tenant-a' } as never
  const identity = { user: { id: 'user-a' } } as never

  it('is refused with an explicit 422 for contracted inventory, never answered as no availability', async () => {
    const { instance, execute } = controller('contracted-inventory')
    const mixed = { ...base, roomStays: [stay(2), stay(1)] }
    await expect(instance.search(mixed as never, identity, request)).rejects.toBeInstanceOf(UnprocessableEntityException)
    await expect(instance.search(mixed as never, identity, request)).rejects.toMatchObject({ response: { code: 'MIXED_ROOM_OCCUPANCY_UNSUPPORTED' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('still searches identical rooms', async () => {
    const { instance, execute } = controller('contracted-inventory')
    execute.mockResolvedValue({ hotels: [] })
    await instance.search({ ...base, adults: 2, roomStays: [stay(2), stay(2)] } as never, identity, request)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
