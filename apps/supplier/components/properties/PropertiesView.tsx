'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Building2, Filter, MoreHorizontal, Plus, Search } from 'lucide-react'
import type { Property } from '../../lib/types'
import { PageHeader } from '../ui/PageHeader'
import { StatusBadge } from '../ui/StatusBadge'

export function HotelsView({ properties }: { properties: Property[] }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? properties.filter((property) => [property.name, property.id, property.destination, property.supplierReference].some((value) => value.toLowerCase().includes(normalized))) : properties
  }, [properties, query])

  return (
    <div className="supplier-page">
      <PageHeader eyebrow="Supply portfolio" title="Hotels" description="Manage hotel content, contracting readiness, inventory health and channel mapping from one operational view." actions={<Link className="btn btn-primary" href="/hotels/new"><Plus size={13} /> Add hotel</Link>} />
      <div className="summary-grid">
        <article><span className="summary-icon red"><Building2 size={15} /></span><div><small>Total properties</small><strong>12</strong></div></article>
        <article><span className="summary-icon green"><Building2 size={15} /></span><div><small>Ready for distribution</small><strong>9</strong></div></article>
        <article><span className="summary-icon amber"><Building2 size={15} /></span><div><small>Need attention</small><strong>2</strong></div></article>
        <article><span className="summary-icon blue"><Building2 size={15} /></span><div><small>Draft</small><strong>1</strong></div></article>
      </div>
      <div className="filter-bar">
        <label className="filter-search"><Search size={14} /><span className="sr-only">Search properties</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by property, destination or ID…" /></label>
        <button className="btn"><Filter size={13} /> Status: All</button><button className="btn">Market: All</button><button className="btn">More filters</button>
        <span>{filtered.length} hotels</span>
      </div>
      <section className="panel">
        <div className="table-wrap">
          <table className="data-table property-table">
            <thead><tr><th>Property</th><th>Content</th><th>Contract</th><th>Inventory</th><th>Mapping</th><th>Updated</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>{filtered.map((property) => <tr key={property.id}>
              <td><div className="property-cell"><span>{property.stars}★</span><div><Link href={`/hotels/${property.id}`}>{property.name}</Link><small>{property.id} · {property.destination}, {property.country}</small></div></div></td>
              <td><div className="score-cell"><strong>{property.contentScore}%</strong><i><em style={{ width: `${property.contentScore}%` }} /></i></div></td>
              <td><StatusBadge>{property.contractStatus}</StatusBadge></td><td><StatusBadge>{property.inventoryStatus}</StatusBadge></td><td><StatusBadge>{property.mappingStatus}</StatusBadge></td>
              <td>{property.lastUpdated}</td><td><StatusBadge>{property.status}</StatusBadge></td><td><button className="row-action" aria-label={`Actions for ${property.name}`}><MoreHorizontal size={15} /></button></td>
            </tr>)}</tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="empty-state"><Search size={24} /><strong>No matching hotels</strong><span>Try a broader hotel name, destination or reference.</span></div>}
        <div className="panel-pagination"><span>Showing {filtered.length} of 12 hotels</span><button disabled>Previous</button><button>Next <ArrowRight size={11} /></button></div>
      </section>
    </div>
  )
}
