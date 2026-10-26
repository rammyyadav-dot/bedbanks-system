import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  icons: { icon: '/fabbeds-logo.svg' },
  title: 'fabBeds Supplier Extranet',
  description: 'Supplier and DMC inventory workspace for fabBeds.',
}

export default function SupplierLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
