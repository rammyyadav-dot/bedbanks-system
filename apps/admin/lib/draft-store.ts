// Recoverable editor drafts. A draft lives in this browser tab's sessionStorage only (never sent anywhere) and is a convenience: every read and write
// is guarded, because storage can be unavailable (private mode, blocked site data, quota). Nothing depends on it for correctness.
const PREFIX = 'fbeds:draft:v1:'

export interface StoredDraft<T> { base: T; value: T; savedAt: string }

export const draftKey = (scope: string, hotelId: string) => `${PREFIX}${scope}:${hotelId}`

export function browserStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}

export function readDraft<T>(storage: Pick<Storage, 'getItem' | 'removeItem'> | null, key: string, valid: (v: unknown) => v is T): StoredDraft<T> | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredDraft<unknown>> | null
    if (parsed && typeof parsed.savedAt === 'string' && valid(parsed.base) && valid(parsed.value)) return { base: parsed.base, value: parsed.value, savedAt: parsed.savedAt }
    storage?.removeItem(key)
  } catch { /* unreadable draft: treated as none */ }
  return null
}

export function writeDraft<T>(storage: Pick<Storage, 'setItem'> | null, key: string, draft: StoredDraft<T>): void {
  try { storage?.setItem(key, JSON.stringify(draft)) } catch { /* storage full or blocked: the draft is simply not kept */ }
}

export function clearDraft(storage: Pick<Storage, 'removeItem'> | null, key: string): void {
  try { storage?.removeItem(key) } catch { /* nothing to clear */ }
}

/** Sign-out must not leave one operator's unsaved edits in the tab for the next person. */
export function clearAllDrafts(storage: Pick<Storage, 'length' | 'key' | 'removeItem'> | null = browserStorage()): void {
  try {
    if (!storage) return
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k?.startsWith(PREFIX)) keys.push(k) }
    keys.forEach((k) => storage.removeItem(k))
  } catch { /* nothing to clear */ }
}
