export type SearchRunState = {
  generation: number
  searching: boolean
}

export function idleSearchRun(): SearchRunState {
  return { generation: 0, searching: false }
}

/**
 * Abandon the in-flight request without clearing a successful result.
 * Searching returns to false so the next submit can start immediately.
 * The generation still advances, so the abandoned request cannot write results.
 */
export function invalidateSearchRun(state: SearchRunState): SearchRunState {
  return { generation: state.generation + 1, searching: false }
}

/** Begin the next authoritative request. A request already in flight is refused. */
export function beginSearchRun(state: SearchRunState): SearchRunState | null {
  if (state.searching) return null
  return { generation: state.generation + 1, searching: true }
}

/**
 * Apply a completion only when it is still the authoritative generation.
 * A stale completion leaves the current searching flag untouched.
 */
export function settleSearchRun(state: SearchRunState, startedGeneration: number): { state: SearchRunState; apply: boolean } {
  if (startedGeneration !== state.generation) return { state, apply: false }
  return { state: { generation: state.generation, searching: false }, apply: true }
}
