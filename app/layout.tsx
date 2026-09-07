import { Analytics } from '@vercel/analytics/next'
import { Barlow_Semi_Condensed, Montserrat } from 'next/font/google'
import type { Metadata, Viewport } from 'next'
import './globals.css'

const montserrat = Montserrat({ subsets: ['latin'], variable: '--font-montserrat', weight: ['400', '500', '600', '700', '800'] })
const barlow = Barlow_Semi_Condensed({ subsets: ['latin'], variable: '--font-barlow', weight: ['400', '500', '600', '700'] })

export const metadata: Metadata = {
  title: 'Atlas Getaways | Wholesale Hotel Search',
  description: 'Live wholesale hotel availability, net rates, and reservation management for Atlas Getaways.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${montserrat.variable} ${barlow.variable} bg-background`}>
      <body className="antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
