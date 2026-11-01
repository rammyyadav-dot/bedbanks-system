import { redirect } from 'next/navigation'

/** The hotel readiness list now lives on /hotels (same authoritative API, with commercial columns and filters). */
export default function HotelReadinessRedirect(): never { redirect('/hotels') }
