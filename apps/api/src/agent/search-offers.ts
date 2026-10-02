import type * as SearchOffers from '@bedbanks/domain/search-offers'

// The TypeScript path points at the declaration file. Node's package export is
// the CommonJS implementation. Load that file directly so the dev compiler
// does not execute the declaration instead of the validators.
const searchOffers = require('../../../../packages/domain/src/search-offers.cjs') as typeof SearchOffers

export const cityDestinationId = searchOffers.cityDestinationId
export const validSearchCriteria = searchOffers.validSearchCriteria
export const validateSearchHotels = searchOffers.validateSearchHotels
export const validateAgentSearchResponse = searchOffers.validateAgentSearchResponse
