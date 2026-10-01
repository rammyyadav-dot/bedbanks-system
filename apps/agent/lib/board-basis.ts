/** Names the contracted catalogue uses for a breakfast-inclusive board. Not a new taxonomy. */
const BREAKFAST_BOARD_NAMES = new Set([
  'breakfast',
  'bed & breakfast',
  'bed and breakfast',
])

function normalizedBoardName(name: string) {
  return name.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
}

/**
 * Breakfast is an exact board name. IDs are tenant records, not a shared board code.
 * A substring such as "No breakfast" is not breakfast.
 */
export function includesBreakfast(boardBasisName: string): boolean {
  return BREAKFAST_BOARD_NAMES.has(normalizedBoardName(boardBasisName))
}
