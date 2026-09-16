import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'fBeds Supplier Portal',
  description: 'Supplier and DMC inventory workspace for fBeds.',
}

export default function SupplierLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
