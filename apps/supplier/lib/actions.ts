'use server'

import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { EXTRANET_BOOKING_ANSWERS, type ExtranetBookingAnswer, type ExtranetBookingStatus } from '@bedbanks/contracts'
import { SupplierApiError, answerBooking, loadContext, loginRequest, logoutRequest, saveRoomDraft } from './supplier-api'
import { parseSessionCookie } from './session-cookie'
import { SESSION_COOKIE_NAME, SUPPLIER_CONTEXT_COOKIE } from './server-env'

export interface ActionState {
  error: string | null
  saved?: boolean
}

function clearSupplierContext(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  cookieStore.set(SUPPLIER_CONTEXT_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 })
}

export async function loginAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  if (!email || !password) return { error: 'Email and password are required.' }
  try {
    const headers = await loginRequest(email, password, formData.get('rememberMe') === 'on')
    const cookie = parseSessionCookie(headers, SESSION_COOKIE_NAME)
    const cookieStore = await cookies()
    cookieStore.set(SESSION_COOKIE_NAME, cookie.value, cookie.options)
    clearSupplierContext(cookieStore)
  } catch (error) {
    if (error instanceof SupplierApiError) {
      if (error.status === 401) return { error: 'Invalid email or password.' }
      if (error.status === 400 || error.status === 422) return { error: 'Check the email address and try again.' }
    }
    return { error: 'Sign in is unavailable. No workspace data was loaded.' }
  }
  redirect('/dashboard')
}

export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)
  if (sessionCookie) {
    try {
      await logoutRequest(`${SESSION_COOKIE_NAME}=${sessionCookie.value}`)
    } catch {
      throw new Error('Sign out failed. The session was not cleared.')
    }
  }
  cookieStore.set(SESSION_COOKIE_NAME, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 })
  clearSupplierContext(cookieStore)
  redirect('/login')
}

export async function selectOrganizationAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const supplierId = String(formData.get('supplierId') ?? '').trim()
  if (!supplierId) return { error: 'Choose an organization.' }
  try {
    await loadContext(supplierId)
    const cookieStore = await cookies()
    cookieStore.set(SUPPLIER_CONTEXT_COOKIE, supplierId, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 8 })
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 401) redirect('/login')
    return { error: 'That organization is not available for this session.' }
  }
  redirect('/hotels')
}

export async function saveRoomDraftAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const hotelId = String(formData.get('hotelId') ?? '').trim()
  const roomId = String(formData.get('roomId') ?? '').trim()
  const supplierNotes = String(formData.get('supplierNotes') ?? '')
  if (!hotelId || !roomId) return { error: 'The draft was not saved.' }
  try {
    await saveRoomDraft(hotelId, roomId, supplierNotes, randomUUID())
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 401) redirect('/login')
    if (error instanceof SupplierApiError && error.status === 403) return { error: 'You cannot edit this draft. The note was not changed.' }
    if (error instanceof SupplierApiError && error.status === 404) return { error: 'This room is not in your organization. The note was not changed.' }
    return { error: 'The draft was not saved. No preview note was stored.' }
  }
  revalidatePath(`/hotels/${hotelId}/rooms`)
  return { error: null, saved: true }
}

export interface AnswerState extends ActionState {
  answered?: ExtranetBookingStatus
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/

/** A supplier answers its own booking (ADR 0061 Amendment 2). The idempotency key is issued with the form, so a double click or a retry cannot apply twice. */
export async function answerBookingAction(_previous: AnswerState, formData: FormData): Promise<AnswerState> {
  const bookingId = String(formData.get('bookingId') ?? '').trim()
  const answer = String(formData.get('answer') ?? '') as ExtranetBookingAnswer
  const expectedStatus = String(formData.get('expectedStatus') ?? '') as ExtranetBookingStatus
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '')
  const supplierRef = String(formData.get('supplierRef') ?? '').trim()
  const hotelConfirmationNo = String(formData.get('hotelConfirmationNo') ?? '').trim()
  const reason = String(formData.get('reason') ?? '').trim()
  if (!bookingId || !IDEMPOTENCY_KEY.test(idempotencyKey) || !expectedStatus) return { error: 'The answer was not sent. Reload the booking and try again.' }
  if (!(EXTRANET_BOOKING_ANSWERS as readonly string[]).includes(answer)) return { error: 'Choose an answer.' }
  if (answer === 'CONFIRMED' && !supplierRef) return { error: 'Enter your booking reference to confirm.' }
  if (answer === 'REJECTED' && reason.length < 10) return { error: 'Give a reason of at least 10 characters to reject.' }
  try {
    const result = await answerBooking(bookingId, {
      answer, expectedStatus,
      ...(answer === 'CONFIRMED' && supplierRef ? { supplierRef } : {}),
      ...(answer === 'CONFIRMED' && hotelConfirmationNo ? { hotelConfirmationNo } : {}),
      ...(answer === 'REJECTED' ? { reason } : {}),
    }, idempotencyKey, randomUUID())
    revalidatePath(`/bookings/${bookingId}`)
    revalidatePath('/bookings')
    return { error: null, saved: true, answered: result.status }
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 401) redirect('/login')
    if (error instanceof SupplierApiError && error.status === 403) return { error: 'You cannot answer bookings. Nothing was sent.' }
    if (error instanceof SupplierApiError && error.status === 404) return { error: 'This booking is not in your organization. Nothing was sent.' }
    if (error instanceof SupplierApiError && error.status === 409) return { error: 'This booking changed or this request was already used for a different answer. Reload the booking to see its current status. Nothing was changed by this attempt.' }
    if (error instanceof SupplierApiError && (error.status === 400 || error.status === 422)) return { error: 'That answer is not available for this booking, or a required field is missing. Nothing was sent.' }
    return { error: 'The answer could not be confirmed. Reload the booking to see whether it was recorded before trying again.' }
  }
}
