// Room Event Master and event/exhibition supplements (ADR 0089). The API prices every stay; this page only manages the catalogue and
// the commercial rules, and previews their effect — it never computes a sell price itself.
import { routes, type EventSupplementAmendmentRequestInput, type EventSupplementApprovalExecuteInput, type EventSupplementPreviewRequest, type EventSupplementPreviewResult, type EventSupplementRead, type EventSupplementSuspendInput, type EventSupplementWrite, type RoomEventRead, type RoomEventTransitionInput, type RoomEventUpdate, type RoomEventWrite } from '@bedbanks/contracts'
import { apiRequest, apiRequestWithMeta } from '../api/client'
import { opsQuery } from '../ops-state'

type Params = Record<string, string | number | boolean | undefined | null>
const c = routes.supply
const json = { 'Content-Type': 'application/json' }
const fill = (path: string, values: Record<string, string>) => Object.entries(values).reduce((p, [k, v]) => p.replace(`:${k}`, encodeURIComponent(v)), path)

export interface Page<T> { items: T[]; page: number; pageSize: number; total: number }
export interface ApprovalView { id: string; status: string; requestedById: string; decidedById: string | null; decisionReason: string | null; canDecide: boolean; canCancel: boolean; canExecute: boolean }
export type RoomEventView = RoomEventRead & { approval?: ApprovalView | null }
export type EventSupplementView = EventSupplementRead & { approval?: ApprovalView | null }

// Room Event Master
export const getRoomEvents = (p: Params = {}) => apiRequest<Page<RoomEventView>>(`${c.roomEvents}${opsQuery(p)}`)
export const getRoomEvent = (roomEventId: string) => apiRequest<RoomEventView>(fill(c.roomEvent, { roomEventId }))
export const createRoomEvent = (body: RoomEventWrite) => apiRequestWithMeta<RoomEventRead>(c.roomEvents, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const updateRoomEvent = (roomEventId: string, body: RoomEventUpdate) => apiRequestWithMeta<RoomEventRead>(fill(c.roomEvent, { roomEventId }), { method: 'PATCH', headers: json, body: JSON.stringify(body) })
export const submitRoomEvent = (roomEventId: string, body: RoomEventTransitionInput) => apiRequestWithMeta<RoomEventView>(fill(c.roomEventSubmit, { roomEventId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const cancelRoomEvent = (roomEventId: string, body: RoomEventTransitionInput) => apiRequestWithMeta<RoomEventRead>(fill(c.roomEventCancel, { roomEventId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const archiveRoomEvent = (roomEventId: string, body: RoomEventTransitionInput) => apiRequestWithMeta<RoomEventRead>(fill(c.roomEventArchive, { roomEventId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const decideRoomEventApproval = (approvalId: string, decision: 'approve' | 'reject', reason: string) =>
  apiRequestWithMeta<RoomEventView>(fill(decision === 'approve' ? c.roomEventApprovalApprove : c.roomEventApprovalReject, { approvalId }), { method: 'POST', headers: json, body: JSON.stringify({ reason }) })
export const cancelRoomEventApproval = (approvalId: string) => apiRequestWithMeta<RoomEventView>(fill(c.roomEventApprovalCancel, { approvalId }), { method: 'POST', headers: json, body: '{}' })

// Event and exhibition supplements
export const getEventSupplements = (p: Params = {}) => apiRequest<Page<EventSupplementView>>(`${c.eventSupplements}${opsQuery(p)}`)
export const getEventSupplement = (eventSupplementId: string) => apiRequest<EventSupplementView>(fill(c.eventSupplement, { eventSupplementId }))
export const createEventSupplement = (body: EventSupplementWrite) => apiRequestWithMeta<EventSupplementRead>(c.eventSupplements, { method: 'POST', headers: json, body: JSON.stringify(body) })
export const submitEventSupplement = (eventSupplementId: string, body: { reason: string; requestId?: string }) => apiRequestWithMeta<EventSupplementView>(fill(c.eventSupplementSubmit, { eventSupplementId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const activateEventSupplement = (eventSupplementId: string, body: { reason: string }) => apiRequestWithMeta<EventSupplementRead>(fill(c.eventSupplementActivate, { eventSupplementId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const suspendEventSupplement = (eventSupplementId: string, body: EventSupplementSuspendInput) => apiRequestWithMeta<EventSupplementRead>(fill(c.eventSupplementSuspend, { eventSupplementId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const requestEventSupplementAmendment = (eventSupplementId: string, body: EventSupplementAmendmentRequestInput) => apiRequestWithMeta<EventSupplementView>(fill(c.eventSupplementAmendmentRequest, { eventSupplementId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const decideEventSupplementApproval = (approvalId: string, decision: 'approve' | 'reject', reason: string) =>
  apiRequestWithMeta<EventSupplementView>(fill(decision === 'approve' ? c.eventSupplementApprovalApprove : c.eventSupplementApprovalReject, { approvalId }), { method: 'POST', headers: json, body: JSON.stringify({ reason }) })
export const cancelEventSupplementApproval = (approvalId: string) => apiRequestWithMeta<EventSupplementView>(fill(c.eventSupplementApprovalCancel, { approvalId }), { method: 'POST', headers: json, body: '{}' })
export const executeEventSupplementApproval = (approvalId: string, body: EventSupplementApprovalExecuteInput) => apiRequestWithMeta<EventSupplementRead>(fill(c.eventSupplementApprovalExecute, { approvalId }), { method: 'POST', headers: json, body: JSON.stringify(body) })
export const previewEventSupplements = (body: EventSupplementPreviewRequest) => apiRequest<EventSupplementPreviewResult>(c.eventSupplementPreview, { method: 'POST', headers: json, body: JSON.stringify(body) })
