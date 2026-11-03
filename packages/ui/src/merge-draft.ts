const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Three-way merge of an operator's draft onto a newer stored version, field by field.
 * Untouched fields (draft equals `base`) take the newer value. Fields only the operator changed keep the draft.
 * Fields both sides changed to different values keep the operator's draft and are listed in `conflicts`.
 */
export function mergeDraft<T extends Record<string, unknown>>(base: T, draft: T, latest: T): { merged: T; conflicts: Array<keyof T> } {
  const merged = { ...latest } as T
  const conflicts: Array<keyof T> = []
  for (const key of Object.keys({ ...base, ...draft, ...latest }) as Array<keyof T>) {
    if (same(draft[key], base[key])) merged[key] = latest[key]
    else if (same(latest[key], base[key]) || same(latest[key], draft[key])) merged[key] = draft[key]
    else { merged[key] = draft[key]; conflicts.push(key) }
  }
  return { merged, conflicts }
}
