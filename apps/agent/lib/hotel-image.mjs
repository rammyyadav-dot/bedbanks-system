// Path of a published hotel's image for an Agent (ADR 0027). The search result carries only ids; the browser builds the request itself
// so it can send the active-tenant header, which an <img src> cannot.
export function hotelImagePath(hotelId, imageId) {
  return `/agent/hotels/${encodeURIComponent(hotelId)}/images/${encodeURIComponent(imageId)}/content`
}
