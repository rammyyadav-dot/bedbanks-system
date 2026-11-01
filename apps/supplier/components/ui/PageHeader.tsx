import type { ReactNode } from 'react'

export function PageHeader({ eyebrow, title, description, actions, tone }: { eyebrow: string; title: string; description: string; actions?: ReactNode; tone?: 'muted' }) {
  return (
    <div className="page-header">
      <div><p className={tone === 'muted' ? 'page-eyebrow is-muted' : 'page-eyebrow'}><i />{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  )
}
