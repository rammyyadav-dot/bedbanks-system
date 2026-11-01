import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmDiscard, hasUnsavedChanges, registerUnsaved } from '../components/hotels/unsaved-guard'

// The browser behaviour (real Chromium, real Next router) is covered by e2e/tests/08-hotel-admin-drafts.spec.ts. This file covers what that run cannot
// force: a traversal the browser refuses to let the page cancel, so the guard must hold popstate back from the router and undo the move itself.
type Fake = EventTarget & Record<string, unknown>
let prompts: string[]; let answers: boolean[]; let goCalls: number[]

function setUp(here = 'http://admin.test/hotels/1?tab=policies') {
  prompts = []; answers = []; goCalls = []
  const url = new URL(here)
  const navigation = Object.assign(new EventTarget(), { currentEntry: { index: 5 } })
  const win = Object.assign(new EventTarget(), {
    navigation, location: { href: url.href, pathname: url.pathname, search: url.search, origin: url.origin },
    confirm: (message: string) => { prompts.push(message); return answers.shift() ?? false },
    history: { go: (delta: number) => { goCalls.push(delta) } },
  }) as unknown as Fake
  Object.assign(globalThis, {
    window: win, document: new EventTarget(),
    PopStateEvent: class extends Event { state: unknown; constructor(type: string, init: { state?: unknown } = {}) { super(type); this.state = init.state } },
  })
  return { win, navigation }
}
const navigateEvent = (cancelable: boolean, destination: string, index: number) =>
  Object.assign(new Event('navigate', { cancelable }), { navigationType: 'traverse', destination: { url: destination, index, sameDocument: true } })

beforeEach(() => { setUp() })

test('with nothing unsaved the guard is silent and installs nothing', () => {
  const { win } = setUp()
  const unprompted = navigateEvent(true, 'http://admin.test/hotels', 4)
  ;(win.navigation as EventTarget).dispatchEvent(unprompted)
  assert.equal(unprompted.defaultPrevented, false)
  assert.equal(confirmDiscard(), true)
  assert.deepEqual(prompts, [])
})

test('a cancelable Back is cancelled when the operator declines, with one prompt', () => {
  const { navigation } = setUp()
  const off = registerUnsaved()
  answers = [false]
  const event = navigateEvent(true, 'http://admin.test/hotels', 4)
  navigation.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(prompts.length, 1)
  off()
})

test('a cancelable Back proceeds on "leave", and the popstate that follows is not asked about again', () => {
  const { win, navigation } = setUp()
  const off = registerUnsaved()
  answers = [true]
  const event = navigateEvent(true, 'http://admin.test/hotels', 4)
  navigation.dispatchEvent(event)
  assert.equal(event.defaultPrevented, false)
  const routerSaw: unknown[] = []
  win.addEventListener('popstate', (e) => routerSaw.push((e as unknown as { state: unknown }).state))
  win.dispatchEvent(Object.assign(new Event('popstate'), { state: { page: 'previous' } }))
  assert.equal(prompts.length, 1)
  assert.deepEqual(routerSaw, [{ page: 'previous' }])
  off()
})

test('a Back the browser will not let us cancel: popstate is held from the router and the move is undone when declined', () => {
  const { win, navigation } = setUp()
  const off = registerUnsaved()
  const routerSaw: unknown[] = []
  win.addEventListener('popstate', (e) => routerSaw.push((e as unknown as { state: unknown }).state)) // the router's listener, registered after ours is armed
  answers = [false]
  navigation.dispatchEvent(navigateEvent(false, 'http://admin.test/hotels', 4)) // from entry 5 back to entry 4
  win.dispatchEvent(Object.assign(new Event('popstate'), { state: { page: 'previous' } }))
  assert.equal(prompts.length, 1)
  assert.deepEqual(routerSaw, [], 'the router never rendered the page the operator declined to visit')
  assert.deepEqual(goCalls, [1], 'one step forward returns to the entry we were on')
  // The traversal that undoes it fires its own popstate, which must also be kept from the router and must not prompt again.
  win.dispatchEvent(Object.assign(new Event('popstate'), { state: { page: 'current' } }))
  assert.deepEqual(routerSaw, [])
  assert.equal(prompts.length, 1)
  off()
})

test('a Forward the browser will not let us cancel is undone with a step back', () => {
  const { win, navigation } = setUp()
  const off = registerUnsaved()
  answers = [false]
  navigation.dispatchEvent(navigateEvent(false, 'http://admin.test/hotels/2', 6))
  win.dispatchEvent(Object.assign(new Event('popstate'), { state: null }))
  assert.deepEqual(goCalls, [-1])
  off()
})

test('an uncancellable Back the operator accepts is handed to the router exactly once, with its state', () => {
  const { win, navigation } = setUp()
  const off = registerUnsaved()
  const routerSaw: unknown[] = []
  win.addEventListener('popstate', (e) => routerSaw.push((e as unknown as { state: unknown }).state))
  answers = [true]
  navigation.dispatchEvent(navigateEvent(false, 'http://admin.test/hotels', 4))
  win.dispatchEvent(Object.assign(new Event('popstate'), { state: { page: 'previous' } }))
  assert.equal(prompts.length, 1)
  assert.deepEqual(routerSaw, [{ page: 'previous' }])
  assert.deepEqual(goCalls, [])
  off()
})

test('a traversal that stays on the same page and query is not a departure', () => {
  const { navigation } = setUp()
  const off = registerUnsaved()
  const event = navigateEvent(true, 'http://admin.test/hotels/1?tab=policies#top', 4)
  navigation.dispatchEvent(event)
  assert.equal(event.defaultPrevented, false)
  assert.equal(prompts.length, 0)
  off()
})

test('two dirty editors share one guard: one prompt per attempt, and it stops listening when both are clean', () => {
  const { navigation } = setUp()
  const offA = registerUnsaved(); const offB = registerUnsaved()
  assert.equal(hasUnsavedChanges(), true)
  answers = [false]
  navigation.dispatchEvent(navigateEvent(true, 'http://admin.test/hotels', 4))
  assert.equal(prompts.length, 1)
  offA()
  assert.equal(hasUnsavedChanges(), true)
  offB()
  assert.equal(hasUnsavedChanges(), false)
  const later = navigateEvent(true, 'http://admin.test/hotels', 4)
  navigation.dispatchEvent(later)
  assert.equal(later.defaultPrevented, false)
  assert.equal(prompts.length, 1)
})

test('beforeunload is raised only while something is unsaved, and not right after the operator already agreed to leave', (t) => {
  const { win } = setUp()
  // Earlier tests in this file answered "leave", which the guard remembers for a moment; start this one well after that.
  const realNow = Date.now; Date.now = () => realNow() + 60_000; t.after(() => { Date.now = realNow })
  const clean = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(clean)
  assert.equal(clean.defaultPrevented, false)
  const off = registerUnsaved()
  const dirty = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(dirty)
  assert.equal(dirty.defaultPrevented, true)
  answers = [true]
  assert.equal(confirmDiscard(), true) // e.g. a click on an external link, answered "leave"
  const afterAgreeing = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(afterAgreeing)
  assert.equal(afterAgreeing.defaultPrevented, false, 'one answer, not two prompts')
  off()
})
