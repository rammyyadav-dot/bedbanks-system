/**
 * Where Tab should move when focus is on the first or last control of a dialog.
 * Returns null when the browser's own Tab order is correct, including when focus is outside the dialog's controls.
 */
export function dialogTabTarget(shiftKey: boolean, index: number, count: number): number | null {
  if (count <= 0 || index < 0 || index >= count) return null
  if (shiftKey && index === 0) return count - 1
  if (!shiftKey && index === count - 1) return 0
  return null
}
