'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { Tabs } from '@/components/common/Tabs'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { emailLogs } from '@/lib/mock'
import type { EmailLog } from '@/lib/types/admin'

export default function NotificationsPage() {
  const columns: DataTableColumn<EmailLog>[] = [
    { key: 'messageId', header: 'Message ID', render: (l) => l.messageId },
    { key: 'event', header: 'Event', render: (l) => l.event },
    { key: 'recipient', header: 'Recipient', render: (l) => l.recipient },
    { key: 'subject', header: 'Subject', render: (l) => l.subject },
    { key: 'status', header: 'Status', render: (l) => <span className={`status-pill ${l.status === 'delivered' ? 'success' : l.status === 'pending' ? 'warning' : 'danger'}`}><i className="status-dot" />{l.status}</span> },
    { key: 'sentAt', header: 'Sent At', render: (l) => new Date(l.sentAt).toLocaleString() },
    { key: 'provider', header: 'Provider', render: (l) => l.provider },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMUNICATIONS" title="Notifications" description="Email delivery dashboard, templates, and logs." />
      <Tabs tabs={[
        { id: 'dashboard', label: 'Email Dashboard', content: (
          <div className="admin-summary-cards">
            <div className="admin-summary-card"><span>Delivered (24h)</span><strong>{emailLogs.filter((l) => l.status === 'delivered').length}</strong></div>
            <div className="admin-summary-card"><span>Bounced (24h)</span><strong>{emailLogs.filter((l) => l.status === 'bounced').length}</strong></div>
            <div className="admin-summary-card"><span>Pending</span><strong>{emailLogs.filter((l) => l.status === 'pending').length}</strong></div>
          </div>
        ) },
        { id: 'templates', label: 'Templates', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Booking Confirmed, Booking Cancelled, Wallet Low Balance, User Invited — mock template list.</div> },
        { id: 'logs', label: 'Delivery Logs', content: <DataTable columns={columns} data={emailLogs} getRowId={(l) => l.id} emptyTitle="No email logs found" /> },
      ]} />
    </div>
  )
}
