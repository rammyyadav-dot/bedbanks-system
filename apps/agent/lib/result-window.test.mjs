import assert from 'node:assert/strict'
import test from 'node:test'
import { resultWindow } from './result-window.ts'

test('shows the first page window from authoritative offset and total', () => {
  assert.deepEqual(resultWindow(0, 25, 100), { start: 1, end: 25, total: 100 })
})

test('shows a middle page without treating the page as the full result', () => {
  assert.deepEqual(resultWindow(50, 25, 100), { start: 51, end: 75, total: 100 })
})

test('shows the true final page', () => {
  assert.deepEqual(resultWindow(75, 25, 100), { start: 76, end: 100, total: 100 })
})

test('shows an empty window when nothing matched', () => {
  assert.deepEqual(resultWindow(0, 0, 0), { start: 0, end: 0, total: 0 })
})
