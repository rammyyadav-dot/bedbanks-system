'use client'

import { useActionState } from 'react'
import { saveRoomDraftAction, type ActionState } from '../../lib/actions'

export function RoomDraftForm({ hotelId, roomId, initialNotes, canEdit }: { hotelId: string; roomId: string; initialNotes: string; canEdit: boolean }) {
  const [state, dispatch, pending] = useActionState(saveRoomDraftAction, { error: null, saved: false } satisfies ActionState)

  return (
    <form action={dispatch} className="draft-note">
      <input type="hidden" name="hotelId" value={hotelId} />
      <input type="hidden" name="roomId" value={roomId} />
      <label htmlFor={`note-${roomId}`}>Private note</label>
      <textarea id={`note-${roomId}`} name="supplierNotes" defaultValue={initialNotes} maxLength={500} disabled={!canEdit || pending} />
      {canEdit ? (
        <button className="btn btn-primary" type="submit" disabled={pending}>Save private note</button>
      ) : (
        <p>Saving is unavailable for this membership. The note cannot be changed.</p>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      {state.saved && <p role="status">Private note saved for this organization.</p>}
    </form>
  )
}
