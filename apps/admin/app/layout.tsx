import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import '@fontsource/poppins/400.css'
import '@fontsource/poppins/500.css'
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/700.css'
import '@fontsource/poppins/800.css'
import '@fontsource/poppins/900.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@bedbanks/ui/src/brand-tokens.css'
import './theme-tokens.css'
import './globals.css'
import { THEME_COOKIE, parseThemePreference } from '@/lib/theme/tokens'

export const metadata: Metadata = {
  title: { default: 'FBEDS Admin Console', template: '%s · FBEDS Admin' },
  description: 'Enterprise administration console for the FBEDS B2B hotel distribution platform.',
}

/** Global theme configuration (ADR 0087, ADR 0102): the fabBeds brand kit lives in @bedbanks/ui (src/brand-tokens.css) and the colour tokens in app/theme-tokens.css; the chosen theme is applied as data-theme on <html>. */
export const viewport: Viewport = { colorScheme: 'light dark', themeColor: '#111111', width: 'device-width', initialScale: 1 }

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read on the server so the first paint already has the right theme (no flash, no inline script).
  const theme = parseThemePreference((await cookies()).get(THEME_COOKIE)?.value)
  return (
    <html lang="en" data-theme={theme}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
