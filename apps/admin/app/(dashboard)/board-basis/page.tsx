'use client'

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { ErrorState } from '@/components/common/ErrorState'
import { LoadingState } from '@/components/common/LoadingState'
import { createBoardBasis, getBoardBasesAdmin, updateBoardBasis, type BoardBasisRecord } from '@/lib/data'

export default function BoardBasisPage() {
  const [items, setItems] = useState<BoardBasisRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const load = useCallback(() => { setLoading(true); setError(''); getBoardBasesAdmin().then(setItems).catch(() => setError('Board Basis data unavailable. No fallback data is shown.')).finally(() => setLoading(false)) }, [])
  useEffect(() => { load() }, [load])
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('')
    try { await createBoardBasis({ code, name }); setCode(''); setName(''); load() } catch { setError('Board Basis could not be created. Check the canonical code, permissions, and validation.') }
  }
  async function toggle(item: BoardBasisRecord) {
    setError('')
    try { await updateBoardBasis(item.id, { isActive: !item.isActive }); load() } catch { setError('Board Basis status could not be updated.') }
  }
  const columns: DataTableColumn<BoardBasisRecord>[] = [
    { key: 'code', header: 'Code', render: b => <strong>{b.code}</strong> },
    { key: 'name', header: 'Name', render: b => b.name },
    { key: 'description', header: 'Description', render: b => b.description ?? '—' },
    { key: 'status', header: 'Status', render: b => <StatusBadge status={b.isActive ? 'active' : 'inactive'} /> },
    { key: 'action', header: 'Action', render: b => <button type="button" className="admin-filter-select" onClick={() => void toggle(b)}>{b.isActive ? 'Deactivate' : 'Activate'}</button> },
  ]
  return <div className="admin-page">
    <PageHeader eyebrow="COMMERCIAL · BOARD BASIS" title="Board Basis" description="Canonical meal-plan codes used by authoritative rate plans." />
    <form className="workspace-panel" style={{ padding: 16, display: 'flex', gap: 10, marginBottom: 16 }} onSubmit={submit}>
      <input className="admin-filter-select" value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={3} placeholder="Code (BB)" required />
      <input className="admin-filter-select" value={name} onChange={e => setName(e.target.value)} placeholder="Display name" required />
      <button className="admin-filter-select" type="submit">Add Board Basis</button>
    </form>
    {error ? <ErrorState title="Board Basis operation failed" description={error} /> : null}
    {loading ? <LoadingState rows={5} /> : <DataTable columns={columns} data={items} getRowId={b => b.id} emptyTitle="No Board Basis records found" />}
  </div>
}
