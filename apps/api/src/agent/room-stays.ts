import type { SearchCriteria } from '@bedbanks/domain'

/**
 * True when every room of the search holds the same party (or no per-room parties were sent). Contracted inventory prices only that case: one
 * party size and child-age list per search. Mixed rooms are refused explicitly (see `AgentController.search`), never answered as "no availability".
 */
export function uniformRoomStays(criteria: Pick<SearchCriteria, 'roomStays'>): boolean {
  const stays = criteria.roomStays
  if (!stays || stays.length === 0) return true
  const first = stays[0]
  return stays.every((stay) => stay.adults === first.adults && stay.children.length === first.children.length &&
    stay.children.every((child, index) => child.age === first.children[index].age))
}

export const MIXED_ROOMS_MESSAGE = 'Different guests per room are not supported by contracted inventory yet. Search identical rooms, or search each room separately.'
