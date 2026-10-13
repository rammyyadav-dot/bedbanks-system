/**
 * Process drain state. Once a termination signal arrives the process stops
 * reporting ready so the load balancer takes it out of rotation while
 * in-flight requests finish (Nest then closes the server and runs the
 * onModuleDestroy hooks via enableShutdownHooks).
 */
let draining = false;

export function beginDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

/** Test seam only. */
export function resetDrainingForTests(): void {
  draining = false;
}
