// One process-wide guard for unsaved hotel drafts. Every editor registers while it is dirty; the guard owns the browser listeners, so two dirty
// editors on one screen produce one prompt, not two.
//
// Next.js 16 (App Router) has no route-blocking API. What it offers, and what this uses:
//   - hard navigation (reload, close, address bar, external link): `beforeunload`;
//   - <Link>/<a> clicks, which include tab changes, hotel switches and keyboard activation: a capturing click listener that runs before the router sees the click;
//   - Back/Forward and Alt+Left/Right: the Navigation API's `navigate` event (cancelable in Chromium for same-document traversals); where the browser
//     will not let the traversal be cancelled, the `popstate` event is held back from the router until the user agrees, and the traversal is undone
//     with history.go() if they do not;
//   - programmatic navigation (router.push, server actions): callers ask with confirmDiscard() first.
// Browsers without the Navigation API get no Back/Forward prompt; recoverable drafts (draft-store.ts) are the safety net there.

export const LEAVE_MESSAGE = 'You have unsaved hotel changes. Leave this page? They are kept in this browser tab for now and restored if you return, but they are not saved to the hotel.'

const sources = new Set<symbol>()
let confirmedAt = -Infinity
let approvedTraversalAt = -Infinity
let reverting = false
let replaying = false
let pendingRevert: { delta: number } | null = null
let installed = false
const RECENT_MS = 1500

type NavigateLike = Event & { navigationType: string; cancelable: boolean; destination: { url: string; index: number; sameDocument: boolean } }
type NavigationLike = EventTarget & { currentEntry: { index: number } | null }
const navigationApi = (): NavigationLike | null => (typeof window !== 'undefined' ? (window as unknown as { navigation?: NavigationLike }).navigation ?? null : null)

export const hasUnsavedChanges = () => sources.size > 0

/**
 * Asks once, with the browser's own dialog, and only when something is unsaved. A "yes" is remembered briefly so a hard navigation that follows the
 * answer does not also raise the browser's `beforeunload` prompt.
 */
export function confirmDiscard(message: string = LEAVE_MESSAGE): boolean {
  if (sources.size === 0) return true
  const ok = window.confirm(message)
  if (ok) confirmedAt = Date.now()
  return ok
}

const samePage = (url: string) => { const a = new URL(url, window.location.href); return a.pathname === window.location.pathname && a.search === window.location.search }

const onBeforeUnload = (event: BeforeUnloadEvent) => {
  if (sources.size === 0 || Date.now() - confirmedAt < RECENT_MS) return
  event.preventDefault(); event.returnValue = ''
}

const onClick = (event: MouseEvent) => {
  if (sources.size === 0) return
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download') || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const next = new URL(link.href, window.location.href)
  if (next.href === window.location.href || (next.origin === window.location.origin && samePage(next.href))) return
  if (!confirmDiscard()) { event.preventDefault(); event.stopPropagation() }
}

const onNavigate = (raw: Event) => {
  const event = raw as NavigateLike
  pendingRevert = null
  if (reverting || sources.size === 0 || event.navigationType !== 'traverse' || !event.destination.sameDocument || samePage(event.destination.url)) return
  if (event.cancelable) {
    if (confirmDiscard()) approvedTraversalAt = Date.now(); else event.preventDefault()
    return
  }
  // The browser will not let this traversal be cancelled, so the popstate that follows is held back from the router (see onPopState).
  const current = navigationApi()?.currentEntry?.index
  pendingRevert = typeof current === 'number' ? { delta: current - event.destination.index } : null
}

const onPopState = (event: PopStateEvent) => {
  if (replaying) return
  if (reverting) { reverting = false; event.stopImmediatePropagation(); return }
  if (Date.now() - approvedTraversalAt < RECENT_MS) { approvedTraversalAt = -Infinity; return }
  const pending = pendingRevert; pendingRevert = null
  if (!pending || sources.size === 0) return
  event.stopImmediatePropagation()
  if (confirmDiscard()) {
    replaying = true
    try { window.dispatchEvent(new PopStateEvent('popstate', { state: event.state })) } finally { replaying = false }
  } else {
    reverting = true
    window.history.go(pending.delta)
  }
}

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('click', onClick, true)
  window.addEventListener('popstate', onPopState, true) // capture: runs before the router's own popstate listener
  navigationApi()?.addEventListener('navigate', onNavigate)
}
function uninstall() {
  if (!installed) return
  installed = false
  window.removeEventListener('beforeunload', onBeforeUnload)
  document.removeEventListener('click', onClick, true)
  window.removeEventListener('popstate', onPopState, true)
  navigationApi()?.removeEventListener('navigate', onNavigate)
  pendingRevert = null; reverting = false
}

/** Marks one editor as holding unsaved edits until the returned function is called. */
export function registerUnsaved(): () => void {
  const id = Symbol('unsaved')
  sources.add(id)
  install()
  return () => { sources.delete(id); if (sources.size === 0) uninstall() }
}
