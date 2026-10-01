import { SellabilityInspector } from '@/components/commercial/SellabilityInspector'

export default async function SellabilityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const value = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '')
  return <SellabilityInspector initialRatePlanId={value('ratePlanId')} initialCheckIn={value('checkIn')} initialNights={value('nights')} />
}
