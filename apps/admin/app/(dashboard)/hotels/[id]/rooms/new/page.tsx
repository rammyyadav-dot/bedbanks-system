import { redirect } from 'next/navigation'

/** Rooms are now managed in the Rooms tab (with concurrency control, validation and audit). This route only forwards there. */
export default async function NewRoomRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/hotels/${encodeURIComponent(id)}?tab=rooms&room=new`)
}
