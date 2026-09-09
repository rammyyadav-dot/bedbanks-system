import type { Metadata } from 'next'
import { AdminShell } from '@/components/admin-shell'
import './globals.css'

export const metadata: Metadata = {
  title: 'Admin · Bedbanks',
  description: 'Administration interface for Bedbanks',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  )
}
