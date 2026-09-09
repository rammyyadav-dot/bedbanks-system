import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'FBEDS Admin Console',
  description: 'Enterprise administration console for the FBEDS B2B hotel distribution platform.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
