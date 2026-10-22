import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import './theme-tokens.css'
import './globals.css'
import { THEME_COOKIE, parseThemePreference } from '@/lib/theme/tokens'

export const metadata: Metadata = {
  title: { default: 'FBEDS Admin Console', template: '%s · FBEDS Admin' },
  description: 'Enterprise administration console for the FBEDS B2B hotel distribution platform.',
}

/** Global theme configuration (ADR 0087): colour tokens live in app/theme-tokens.css; the chosen theme is applied as data-theme on <html>. */
export const viewport: Viewport = { colorScheme: 'light dark', themeColor: '#0d2631', width: 'device-width', initialScale: 1 }

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read on the server so the first paint already has the right theme (no flash, no inline script).
  const theme = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value)
  return (
    <html lang="en" data-theme={theme}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
