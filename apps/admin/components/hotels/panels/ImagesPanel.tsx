'use client'

import { useRef, useState } from 'react'
import { HOTEL_IMAGE_LIMITS, HOTEL_IMAGE_TYPES, type HotelImageView } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag } from '@/components/ops/ops-ui'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { AuthImage } from '@/components/hotels/AuthImage'
import { deleteHotelImage, getHotelImages, reorderHotelImages, updateHotelImage, uploadHotelImage } from '@/lib/data/hotel-images'
import { useCan } from '@/lib/auth/capabilities'

const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
const MB = 1024 * 1024

/**
 * Hotel images (ADR 0027). Real storage, real limits: the API reads the type and size from the bytes and refuses anything else.
 * The checks here only save a round trip. Images are not yet shown to Agents or the Website.
 */
export function ImagesPanel({ hotelId }: { hotelId: string }) {
  const canManage = useCan()('supply.hotels.manage')
  const [version, setVersion] = useState(0)
  const query = useOpsQuery(() => getHotelImages(hotelId), [hotelId, version])
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [alt, setAlt] = useState(''); const [file, setFile] = useState<File | null>(null); const fileInput = useRef<HTMLInputElement>(null)

  async function act(label: string, work: () => Promise<void>, done: string) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null)
    try { await work(); setNotice({ tone: 'ok', text: done }); setVersion((v) => v + 1) } catch (e) { const p = apiErrorParts(e, label); setNotice({ tone: 'bad', text: [p.message, ...p.details].join(' ') + (p.requestId ? ` Request id: ${p.requestId}` : '') }) } finally { inFlight.current = false; setBusy(false) }
  }
  const fileProblem = file && (!(HOTEL_IMAGE_TYPES as readonly string[]).includes(file.type) ? 'Use a JPEG, PNG or WebP image.' : file.size > HOTEL_IMAGE_LIMITS.maxBytes ? `An image can be at most ${HOTEL_IMAGE_LIMITS.maxBytes / MB} MB.` : null)

  return (
    <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 12 }} aria-label="Hotel images" data-testid="hotel-images">
      <h2 style={{ fontSize: 14, margin: 0 }}>Images</h2>
      <OpsState state={query.state} onRetry={query.reload} isEmpty={() => false}>
        {(d) => {
          const items = d.items
          const move = (i: number, dir: -1 | 1) => {
            if (!items[i] || !items[i + dir]) return
            const next = items.map((x) => x.id); [next[i], next[i + dir]] = [next[i + dir], next[i]]
            void act('reorder the images', async () => { await reorderHotelImages(hotelId, { imageIds: next }) }, 'Order updated.')
          }
          return (
            <>
              <p style={note}>JPEG, PNG or WebP, at most {d.limits.maxBytes / MB} MB and {d.limits.minWidth}x{d.limits.minHeight} to {d.limits.maxWidth}x{d.limits.maxHeight} pixels, up to {d.limits.maxPerHotel} images. {items.length} of {d.limits.maxPerHotel} used. Alt text is required. The first image becomes the primary image. Images are stored privately and are not yet shown to Agents or on the Website.</p>
              {canManage && (
                <form data-testid="image-upload" onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
                  <label style={lab}>Image file<input ref={fileInput} type="file" accept={HOTEL_IMAGE_TYPES.join(',')} data-testid="image-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
                  <label style={{ ...lab, minWidth: 260 }}>Alt text (required)<input className="input-wrap" value={alt} maxLength={HOTEL_IMAGE_LIMITS.altTextMax} onChange={(e) => setAlt(e.target.value)} placeholder="Describe what the image shows" /></label>
                  <button type="submit" className="button primary" data-testid="image-upload-submit" disabled={busy || !file || !!fileProblem || alt.trim() === '' || items.length >= d.limits.maxPerHotel}
                    onClick={() => file && void act('upload the image', async () => { await uploadHotelImage(hotelId, file, alt.trim()); setFile(null); setAlt(''); if (fileInput.current) fileInput.current.value = '' }, 'Image uploaded.')}>{busy ? 'Working…' : 'Upload image'}</button>
                  {fileProblem && <span role="alert" style={{ ...note, color: '#8a1c1c' }}>{fileProblem}</span>}
                </form>
              )}
              {!canManage && <p style={note}>You can view images but not change them.</p>}
              {items.length === 0
                ? <p role="status" data-testid="images-empty" style={{ margin: 0, fontSize: 13 }}><strong>No images yet.</strong> Nothing is shown for this hotel until one is uploaded.</p>
                : (
                  <ul data-testid="image-grid" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
                    {items.map((img, i) => <ImageCard key={img.id} img={img} index={i} count={items.length} busy={busy} canManage={canManage} onMove={move}
                      onSaveAlt={(text) => void act('save the alt text', async () => { await updateHotelImage(hotelId, img.id, { altText: text }) }, 'Alt text saved.')}
                      onPrimary={() => void act('set the primary image', async () => { await updateHotelImage(hotelId, img.id, { isPrimary: true }) }, 'Primary image changed.')}
                      onDelete={() => { if (window.confirm('Delete this image? This cannot be undone.')) void act('delete the image', async () => { await deleteHotelImage(hotelId, img.id) }, 'Image deleted.') }} />)}
                  </ul>
                )}
            </>
          )
        }}
      </OpsState>
      {notice && <p role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="image-notice" style={{ margin: 0, color: notice.tone === 'bad' ? '#a11d1d' : '#0b6b55' }}>{notice.text}</p>}
    </section>
  )
}

function ImageCard({ img, index, count, busy, canManage, onMove, onSaveAlt, onPrimary, onDelete }: { img: HotelImageView; index: number; count: number; busy: boolean; canManage: boolean; onMove: (i: number, dir: -1 | 1) => void; onSaveAlt: (t: string) => void; onPrimary: () => void; onDelete: () => void }) {
  const [text, setText] = useState(img.altText)
  return (
    <li data-testid="image-card" data-primary={img.isPrimary} style={{ border: '1px solid #d7e1e4', borderRadius: 8, padding: 8, display: 'grid', gap: 6, background: '#fff' }}>
      <AuthImage contentPath={img.contentPath} alt={img.altText} width={img.width} height={img.height} fallback={<div style={{ width: '100%', aspectRatio: '4 / 3', borderRadius: 6, background: '#eef3f5' }} aria-hidden="true" />} style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 6, background: '#eef3f5' }} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {img.isPrimary && <Tag tone="ok">primary</Tag>}
        <span style={note}>{img.width}x{img.height} · {Math.round(img.bytes / 1024)} KB · {img.contentType.replace('image/', '').toUpperCase()}</span>
      </div>
      {canManage ? (
        <>
          <label style={lab}>Alt text<input className="input-wrap" value={text} maxLength={HOTEL_IMAGE_LIMITS.altTextMax} onChange={(e) => setText(e.target.value)} /></label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="admin-btn" disabled={busy || text.trim() === '' || text.trim() === img.altText} onClick={() => onSaveAlt(text)}>Save alt text</button>
            {!img.isPrimary && <button type="button" className="admin-btn" disabled={busy} onClick={onPrimary}>Make primary</button>}
            <button type="button" className="admin-btn" disabled={busy || index === 0} aria-label="Move earlier" onClick={() => onMove(index, -1)}>↑</button>
            <button type="button" className="admin-btn" disabled={busy || index === count - 1} aria-label="Move later" onClick={() => onMove(index, 1)}>↓</button>
            <button type="button" className="admin-btn" disabled={busy} onClick={onDelete}>Delete</button>
          </div>
        </>
      ) : <p style={{ ...note, fontSize: 12 }}>{img.altText}</p>}
    </li>
  )
}
