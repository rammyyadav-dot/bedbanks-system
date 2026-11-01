import assert from 'node:assert/strict'
import test from 'node:test'
import { bookingFilters, filtersToQuery } from './booking-filters'

test('reads only known, valid filters', () => {
  const { values, ignored } = bookingFilters({ status: 'CONFIRMED', reference: 'FB-ABC', checkInFrom: '2099-01-01', checkInTo: '2099-02-01', cursor: 'abc_-' })
  assert.deepEqual(values, { status: 'CONFIRMED', reference: 'FB-ABC', checkInFrom: '2099-01-01', checkInTo: '2099-02-01', cursor: 'abc_-' })
  assert.deepEqual(ignored, [])
})

test('drops and reports invalid values and never forwards tenant or supplier selectors', () => {
  const { values, ignored } = bookingFilters({ status: 'BOGUS', reference: "x' OR 1=1", checkInFrom: 'tomorrow', supplierId: 'other', tenantId: 'other', cursor: '../x' })
  assert.deepEqual(values, {})
  assert.deepEqual(ignored.sort(), ['checkInFrom', 'cursor', 'reference', 'status'])
  assert.equal(filtersToQuery({ ...values }), '')
})

test('an inverted arrival range is dropped as a whole', () => {
  const { values, ignored } = bookingFilters({ checkInFrom: '2099-05-01', checkInTo: '2099-04-01' })
  assert.deepEqual(values, {})
  assert.deepEqual(ignored, ['arrival range'])
})

test('serialises filters for the next-page link', () => {
  assert.equal(filtersToQuery({ status: 'CONFIRMED', cursor: 'abc' }), 'status=CONFIRMED&cursor=abc')
})
