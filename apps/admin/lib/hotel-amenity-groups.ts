/** Presentation groups only: codes, selection and validation remain in the canonical amenity catalogue. */
export function amenityGroup(code: string): string {
  if (['RESTAURANT', 'BAR', 'ROOM_SERVICE', 'BREAKFAST', 'MINIBAR', 'COFFEE_MAKER', 'KITCHENETTE'].includes(code)) return 'Dining'
  if (['POOL', 'SPA', 'GYM', 'BEACH_ACCESS'].includes(code)) return 'Wellness & leisure'
  if (['PARKING', 'AIRPORT_SHUTTLE'].includes(code)) return 'Transport'
  if (['BUSINESS_CENTRE', 'MEETING_ROOMS', 'WORK_DESK'].includes(code)) return 'Business'
  if (['KIDS_CLUB', 'WHEELCHAIR_ACCESS'].includes(code)) return 'Family & accessibility'
  return 'Services & room facilities'
}
