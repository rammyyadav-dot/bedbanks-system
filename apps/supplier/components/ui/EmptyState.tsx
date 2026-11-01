import type { LucideIcon } from 'lucide-react'

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={24} aria-hidden="true" /></span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  )
}
