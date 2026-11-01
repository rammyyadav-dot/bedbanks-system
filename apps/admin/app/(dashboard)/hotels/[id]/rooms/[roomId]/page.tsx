import { redirect } from 'next/navigation'

/** Rooms are now managed in the Rooms tab. This route only forwards there, opening the room's editor. */
export default async function RoomRedirect({ params }: { params: Promise<{ id: string; roomId: string }> }) {
  const { id, roomId } = await params
  redirect(`/hotels/${encodeURIComponent(id)}?tab=rooms&room=${encodeURIComponent(roomId)}`)
}
