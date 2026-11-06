import assert from 'node:assert/strict'
import test from 'node:test'
import { beginStroke, clearPaintMode, emptyPaint, fillRange, paintStroke, resetPaint, undoPaint } from './room-sales-paint'

const cell = (stayDate: string) => ({ roomTypeId: 'deluxe', stayDate, version: 1 })

test('a stroke assigns the mode and a second pass does not toggle it', () => {
  const stroke = beginStroke()
  const first = paintStroke({ ...emptyPaint('2026-11-06', '2026-11-08'), mode: 'STOP_SALE' }, [cell('2026-11-06')], stroke)
  const second = paintStroke(first, [cell('2026-11-06'), cell('2026-11-07')], stroke)
  assert.equal(second.cells.length, 2)
  assert.equal(second.cells.filter((item) => item.stayDate === '2026-11-06').length, 1)
  assert.equal(second.cells.every((item) => item.mode === 'STOP_SALE'), true)
})

test('Limited and On Request cannot paint until their settings exist', () => {
  const blocked = paintStroke({ ...emptyPaint('2026-11-06', '2026-11-06'), mode: 'LIMITED', salesCap: '' }, [cell('2026-11-06')], beginStroke())
  assert.equal(blocked.cells.length, 0)
  const ready = paintStroke({ ...emptyPaint('2026-11-06', '2026-11-06'), mode: 'LIMITED', salesCap: '4' }, [cell('2026-11-06')], beginStroke())
  assert.equal(ready.cells[0]?.salesCap, 4)
  const request = paintStroke({ ...emptyPaint('2026-11-06', '2026-11-06'), mode: 'ON_REQUEST', owner: 'Reservations', escalation: 'Escalate to the duty manager' }, [cell('2026-11-06')], beginStroke())
  assert.equal(request.cells.length, 1)
})

test('fill range is inclusive and honours weekdays, undo and reset', () => {
  const base = { ...emptyPaint('2026-11-06', '2026-11-08'), mode: 'FREE_SALE' as const, weekdays: ['FRI', 'SUN'] }
  const filled = fillRange(base, [{ id: 'deluxe' }, { id: 'classic' }], [])
  assert.equal(filled.error, null)
  assert.deepEqual(filled.draft.cells.map((item) => item.stayDate).sort(), ['2026-11-06', '2026-11-06', '2026-11-08', '2026-11-08'])
  const undone = undoPaint(filled.draft)
  assert.equal(undone.cells.length, 0)
  const again = fillRange(base, [{ id: 'deluxe' }], [])
  assert.equal(resetPaint(again.draft).cells.length, 0)
  assert.equal(clearPaintMode(again.draft).mode, null)
  assert.equal(clearPaintMode(again.draft).cells.length, again.draft.cells.length)
})
