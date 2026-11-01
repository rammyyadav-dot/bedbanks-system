import type { Metadata } from 'next'
import '@fontsource/poppins/400.css'
import '@fontsource/poppins/500.css'
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/700.css'
import '@fontsource/poppins/800.css'
import '@fontsource/poppins/900.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@bedbanks/ui/src/brand-tokens.css'
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
