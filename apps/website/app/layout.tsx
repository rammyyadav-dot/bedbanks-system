import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  metadataBase: new URL('https://fbeds-website.vercel.app'),
  title: { default: 'FBEDS | Global Hotel Distribution & Bedbank Technology', template: '%s | FBEDS' },
  description: 'The infrastructure layer for modern hotel distribution. Connect inventory, buyers and booking technology through one intelligent B2B platform.',
  openGraph: { title: 'FBEDS | Global Hotel Distribution & Bedbank Technology', description: 'Connect. Distribute. Book. Grow.', url: 'https://fbeds-website.vercel.app', siteName: 'FBEDS', type: 'website' },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="bg-background"><body className={`${inter.variable} font-sans`}>{children}</body></html>
}
