import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'FBEDS Admin Console', template: '%s · FBEDS Admin' },
  description: 'Enterprise administration console for the FBEDS B2B hotel distribution platform.',
}

/** Global theme configuration: the console ships a single light theme; tokens live in components/layout/shell-theme.css. */
export const viewport: Viewport = { colorScheme: 'light', themeColor: '#0d2631', width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
