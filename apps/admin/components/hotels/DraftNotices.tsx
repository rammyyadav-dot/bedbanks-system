'use client'

const note = { color: 'var(--c-3f565c)', fontSize: 11, margin: 0 } as const

export interface SaveFailure { message: string; details: string[]; requestId: string | null; stale: boolean }

/** A failed save. The draft stays exactly as typed; a stale version is explained and offers an explicit way forward. */
export function SaveFailureNotice({ failure, testId, busy, onKeepMine, onDiscardMine }: { failure: SaveFailure; testId?: string; busy: boolean; onKeepMine: () => void; onDiscardMine: () => void }) {
  return (
    <div role="alert" data-testid={testId} className="admin-error" style={{ padding: 12, display: 'grid', gap: 6 }}>
      <strong>{failure.message}</strong>
      {failure.details.length > 0 && <ul style={{ margin: 0 }}>{failure.details.map((d) => <li key={d}>{d}</li>)}</ul>}
      {failure.requestId && <div style={note}>Request id: <code>{failure.requestId}</code></div>}
      {failure.stale
        ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={note}>Your edits are still here and nothing was saved.</span>
            <button type="button" className="admin-btn" disabled={busy} onClick={onKeepMine} data-testid="stale-keep">Load the latest version and keep my edits</button>
            <button type="button" className="admin-btn" disabled={busy} onClick={onDiscardMine} data-testid="stale-discard">Discard my edits and load the latest version</button>
          </div>
        : <span style={note}>Your edits are still here. Fix the problem above and save again; saving again is safe.</span>}
    </div>
  )
}

/** Shown after unsaved edits came back from this browser tab, or after the stored version changed under the draft. */
export function DraftStatus({ recoveredAt, conflicts, busy, onDiscard, onDismiss }: { recoveredAt: string | null; conflicts: string[]; busy: boolean; onDiscard: () => void; onDismiss: () => void }) {
  if (!recoveredAt && conflicts.length === 0) return null
  return (
    <div role="status" data-testid="draft-status" className="workspace-panel" style={{ padding: 10, display: 'grid', gap: 6 }}>
      {recoveredAt && <span style={{ fontSize: 12 }}>Unsaved edits from {new Date(recoveredAt).toLocaleTimeString()} were restored in this browser tab. They are not saved to the hotel yet.</span>}
      {conflicts.length > 0 && <span style={{ fontSize: 12 }}>The hotel was changed by someone else in: <strong>{conflicts.join(', ')}</strong>. Your version of these is kept; review it before saving, because saving replaces the newer value.</span>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="admin-btn" disabled={busy} onClick={onDiscard}>Discard these edits</button>
        <button type="button" className="admin-btn" onClick={onDismiss}>Keep editing</button>
      </div>
    </div>
  )
}
