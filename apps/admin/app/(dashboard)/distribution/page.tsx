import { PageHeader } from '@/components/common/PageHeader'
import { getSearchComparison } from '@/lib/data'

export default async function DistributionPage() {
  const results = await getSearchComparison()
  return (
    <div className="admin-page">
      <PageHeader eyebrow="DISTRIBUTION · SEARCH MONITOR" title="Search Monitor" description="Compare live supplier response time, mapping, and pricing outcomes for a search. Mock data." />

      <div className="workspace-panel" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <label className="admin-login-field"><span style={{ font: "9px 'Courier New', monospace", color: '#7c949a' }}>DESTINATION</span><input defaultValue="Dubai" /></label>
          <label className="admin-login-field"><span style={{ font: "9px 'Courier New', monospace", color: '#7c949a' }}>CHECK-IN</span><input type="date" defaultValue="2026-10-02" /></label>
          <label className="admin-login-field"><span style={{ font: "9px 'Courier New', monospace", color: '#7c949a' }}>CHECK-OUT</span><input type="date" defaultValue="2026-10-06" /></label>
          <label className="admin-login-field"><span style={{ font: "9px 'Courier New', monospace", color: '#7c949a' }}>ROOMS / ADULTS</span><input defaultValue="1 room, 2 adults" /></label>
        </div>
        <button type="button" className="admin-btn admin-btn-primary" style={{ marginTop: 12 }}>Run mock search</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {results.map((r) => (
          <div key={r.supplier} className="workspace-panel" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, color: '#17333e', fontSize: 12, marginBottom: 10 }}>{r.supplier}</div>
            <div style={{ fontSize: 11, color: '#4a6a73', lineHeight: 1.9 }}>
              <div>Response: <strong>{r.responseMs >= 1000 ? `${(r.responseMs / 1000).toFixed(1)}s` : `${r.responseMs}ms`}</strong></div>
              <div>Results: <strong>{r.results}</strong></div>
              <div>Mapped: <strong>{r.mapped}</strong></div>
              <div>Deduplicated: <strong>{r.deduplicated}</strong></div>
              <div>Priced: <strong>{r.priced}</strong></div>
            </div>
            <span className={`status-pill ${r.status === 'ok' ? 'success' : r.status === 'slow' ? 'warning' : 'danger'}`} style={{ marginTop: 10 }}>
              <i className="status-dot" />{r.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
