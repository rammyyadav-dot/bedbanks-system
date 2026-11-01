import type { HotelCommercialRow } from '@bedbanks/contracts'
import { HOTEL_EXPORT_STREAM_BATCH, HOTEL_EXPORT_STREAM_MAX_ROWS, hotelCsv, hotelCsvHeader, hotelCsvLines } from './hotel-export'
import { OperationsHotelsService } from './operations-hotels.service'
import type { PrismaService } from '../database/prisma.service'

const record = (i: number) => ({ id: `h${String(i).padStart(4, '0')}`, name: `Hotel ${String(i).padStart(4, '0')}` })
const csvRow = (r: { id: string; name: string }) => ({ id: r.id, name: r.name, code: null, countryCode: 'AE', city: 'Dubai', propertyType: 'HOTEL', starRating: 4, contentStatus: 'COMPLETE', hotelMapping: 'MAPPED', verifiedMappings: 1, rooms: { total: 1, active: 1, mapped: 1 }, contractState: 'ACTIVE', rates: 'OK', inventory: 'OK', readiness: 'READY', issues: { total: 0, critical: 0, high: 0, warning: 0 }, updatedAt: '2026-10-11T00:00:00.000Z' }) as unknown as HotelCommercialRow

describe('hotel CSV pieces (ADR 0074)', () => {
  it('header plus lines is byte-identical to the buffered CSV', () => {
    const rows = [csvRow(record(1)), csvRow(record(2))]
    expect(hotelCsvHeader() + hotelCsvLines(rows)).toBe(hotelCsv(rows))
    expect(hotelCsvLines([])).toBe('')
  })
})

function build(total: number, pageLog: Array<unknown> = []) {
  const all = Array.from({ length: total }, (_, i) => record(i + 1))
  const audits: Array<{ action: string; payload: Record<string, unknown> }> = []
  const tx = {
    hotel: {
      count: jest.fn(async () => total),
      findMany: jest.fn(async (args: { where: { AND?: Array<{ OR?: Array<{ name?: { gt: string }; id?: { gt: string } }> }> }; take: number }) => {
        pageLog.push(args)
        const after = args.where.AND?.[1]?.OR?.[0]?.name?.gt
        return all.filter((h) => after === undefined || h.name > after).slice(0, args.take)
      }),
    },
    auditEvent: { create: jest.fn(async ({ data }: { data: { action: string; payload: Record<string, unknown> } }) => { audits.push(data); return data }) },
  }
  const prisma = { withTenant: async (_t: string, work: (t: unknown) => unknown) => work(tx) } as unknown as PrismaService
  const svc = new OperationsHotelsService(prisma)
  const priv = svc as unknown as Record<string, unknown>
  priv.assessAll = async (_tx: unknown, _t: string, hotels: unknown[]) => new Map((hotels as Array<{ id: string }>).map((h) => [h.id, {}]))
  priv.rowExtras = async () => ({ available: true, for: () => ({}) })
  priv.row = (h: { id: string; name: string }) => csvRow(h)
  return { svc, audits, tx }
}

describe('OperationsHotelsService.openExportStream (ADR 0074)', () => {
  it('audits before the first byte, streams every row once in keyset batches, and records a completed finish', async () => {
    const pages: unknown[] = []
    const { svc, audits } = build(HOTEL_EXPORT_STREAM_BATCH * 2 + 7, pages)
    const out = await svc.openExportStream('t1', 'u1', {}, 'req-1')
    expect(out).toMatchObject({ expectedRows: HOTEL_EXPORT_STREAM_BATCH * 2 + 7, truncated: false })
    expect(audits.map((a) => a.action)).toEqual(['hotel.exported']) // before any chunk is pulled
    expect(audits[0]!.payload).toMatchObject({ streamed: true, outcome: 'allowed', requestId: 'req-1' })
    let text = ''
    for await (const chunk of out.chunks) text += chunk
    const ids = text.trim().split('\r\n').slice(1).map((l) => l.split(',')[0])
    expect(ids).toHaveLength(HOTEL_EXPORT_STREAM_BATCH * 2 + 7)
    expect(new Set(ids).size).toBe(ids.length)
    expect(pages).toHaveLength(3)
    expect(audits.map((a) => a.action)).toEqual(['hotel.exported', 'hotel.export_finished'])
    expect(audits[1]!.payload).toMatchObject({ rowCount: ids.length, completed: true })
  })

  it('stops reading and records an unfinished export when the consumer goes away', async () => {
    const pages: unknown[] = []
    const { svc, audits } = build(HOTEL_EXPORT_STREAM_BATCH * 5, pages)
    const out = await svc.openExportStream('t1', 'u1', {}, null)
    const it = out.chunks[Symbol.asyncIterator]()
    await it.next() // header
    await it.next() // first batch
    await it.return?.(undefined)
    expect(pages).toHaveLength(1)
    expect(audits[1]).toMatchObject({ action: 'hotel.export_finished' })
    expect(audits[1]!.payload).toMatchObject({ rowCount: HOTEL_EXPORT_STREAM_BATCH, completed: false })
  })

  it('reports a failed read as an error and an unfinished export, never as a complete file', async () => {
    const { svc, audits, tx } = build(HOTEL_EXPORT_STREAM_BATCH * 3)
    const out = await svc.openExportStream('t1', 'u1', {}, null)
    tx.hotel.findMany.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'P1001' }))
    await expect((async () => { for await (const _ of out.chunks) void _ })()).rejects.toThrow('boom')
    expect(audits[1]!.payload).toMatchObject({ completed: false, failure: 'P1001', rowCount: 0 })
  })

  it('announces truncation up front when the directory is larger than the stream limit', async () => {
    const { svc } = build(3)
    const priv = svc as unknown as { prisma: { withTenant: (t: string, w: (x: unknown) => unknown) => unknown } }
    priv.prisma.withTenant = async (_t, work) => work({ hotel: { count: async () => HOTEL_EXPORT_STREAM_MAX_ROWS + 1 }, auditEvent: { create: async () => ({}) } })
    const out = await svc.openExportStream('t1', 'u1', {}, null)
    expect(out).toMatchObject({ expectedRows: HOTEL_EXPORT_STREAM_MAX_ROWS, truncated: true })
  })
})
