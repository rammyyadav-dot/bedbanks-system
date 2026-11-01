import { redirect } from 'next/navigation'

/** Rates and inventory are edited together; keep the old route working. */
export default function InventoryRedirect() {
  redirect('/rates')
}
