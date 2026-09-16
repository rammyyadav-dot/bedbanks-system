import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'fBeds Supplier Portal',
  description: 'Supplier and DMC inventory workspace for fBeds.',
}

export default function SupplierLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>
}
