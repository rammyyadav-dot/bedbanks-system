import { ImageResponse } from 'next/og'
export const alt = 'fabbeds B2B hotel distribution marketplace'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export default function Image() { return new ImageResponse(<div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#121212', color: '#FFFFFF', padding: 72, fontFamily: 'Arial' }}><div style={{ display: 'flex', fontSize: 42, fontWeight: 800 }}><span style={{ color: '#E50914' }}>fab</span>beds</div><div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}><div style={{ color: '#FFD700', fontSize: 20, letterSpacing: 4, textTransform: 'uppercase' }}>The next generation of B2B hotel distribution</div><div style={{ fontSize: 64, lineHeight: 1.05, fontWeight: 800, maxWidth: 960 }}>The World’s Wholesale Marketplace.</div></div></div>, size) }
