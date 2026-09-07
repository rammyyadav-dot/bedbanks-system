import { AdminShell } from '@/components/admin-shell'

export const metadata = {
  title: 'Admin · Bedbanks',
  description: 'Administration interface for Bedbanks',
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminShell>
      {children}
    </AdminShell>
  )
}
