// The backlog of the booking Finance consumer (ADR 0076). Read-only; no mock or fallback data lives here.
import { routes, type PostingBacklogView } from '@bedbanks/contracts'
import { apiRequest } from '../api/client'

export const getBookingPostingBacklog = () => apiRequest<PostingBacklogView>(routes.adminBookingFinancePostings.backlog)
