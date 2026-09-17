import { ImageResponse } from 'next/og'
export const alt = 'fBeds hotel distribution platform'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export default function Image() { return new ImageResponse(<div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#1F2937', color: '#FFFFFF', padding: 72, fontFamily: 'Arial' }}><div style={{ display: 'flex', fontSize: 42, fontWeight: 800 }}><span style={{ color: '#D90429' }}>f</span>Beds</div><div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}><div style={{ color: '#10B981', fontSize: 20, letterSpacing: 4, textTransform: 'uppercase' }}>B2B hotel distribution</div><div style={{ fontSize: 64, lineHeight: 1.05, fontWeight: 800, maxWidth: 960 }}>Connect hotel supply with B2B demand.</div></div></div>, size) }
