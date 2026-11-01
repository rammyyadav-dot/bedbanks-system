/**
 * The canonical room occupancy rule, shared by the supply API and the Admin hotel room API so the two cannot diverge:
 * at least one adult, a non-negative child count, and a maximum occupancy no smaller than adults plus children.
 */
export function occupancyProblems(maxAdults: unknown, maxChildren: unknown, maxOccupancy: unknown): string[] {
  const problems: string[] = []
  if (!Number.isInteger(maxAdults) || (maxAdults as number) < 1) problems.push('maxAdults: must be a whole number of at least 1')
  if (!Number.isInteger(maxChildren) || (maxChildren as number) < 0) problems.push('maxChildren: must be a whole number of at least 0')
  if (!Number.isInteger(maxOccupancy)) problems.push('maxOccupancy: must be a whole number')
  else if (problems.length === 0 && (maxOccupancy as number) < (maxAdults as number) + (maxChildren as number)) problems.push('maxOccupancy: must be at least maxAdults plus maxChildren')
  return problems
}
