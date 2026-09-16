import { ArrowRight, Download, Filter, Plus, Search } from 'lucide-react'
import type { ModuleConfig } from '../../lib/module-data'
import { PageHeader } from '../ui/PageHeader'
import { StatusBadge } from '../ui/StatusBadge'

export function OperationalModule({ config }: { config: ModuleConfig }) {
  const Icon = config.icon
  return <div className="supplier-page"><PageHeader eyebrow={config.eyebrow} title={config.title} description={config.description} actions={<><button className="btn"><Download size={13} /> Export</button><button className="btn btn-primary"><Plus size={13} /> {config.action}</button></>} />
    {config.notice && <div className={`module-notice ${config.notice.tone}`}><span>i</span><div><strong>{config.notice.title}</strong><small>{config.notice.detail}</small></div></div>}
    <section className="module-stats">{config.stats.map((stat, index) => <article key={stat.label}><span className={`module-stat-icon stat-${index}`}><Icon size={15} /></span><div><small>{stat.label}</small><strong>{stat.value}</strong><p>{stat.detail}</p></div></article>)}</section>
    <div className="filter-bar"><label className="filter-search"><Search size={14} /><span className="sr-only">Search {config.title}</span><input placeholder={`Search ${config.title.toLowerCase()}…`} /></label><button className="btn"><Filter size={13} /> Status: All</button><button className="btn">Property: All</button><span>{config.rows.length} records</span></div>
    <section className="panel"><div className="table-wrap"><table className="data-table module-table"><thead><tr>{config.columns.map((column) => <th key={column}>{column}</th>)}<th>Status</th><th aria-label="Actions" /></tr></thead><tbody>{config.rows.map((row) => <tr key={row.id}>{row.cells.map((cell, index) => <td key={`${row.id}-${config.columns[index]}`}><strong>{index === 0 ? cell : undefined}</strong>{index === 0 ? <small>{row.id}</small> : cell}</td>)}<td><StatusBadge tone={row.tone}>{row.status}</StatusBadge></td><td><button className="row-action" aria-label={`Open ${row.id}`}><ArrowRight size={14} /></button></td></tr>)}</tbody></table></div><div className="panel-pagination"><span>Showing {config.rows.length} records · UI preview data</span><button disabled>Previous</button><button>Next <ArrowRight size={11} /></button></div></section>
  </div>
}
