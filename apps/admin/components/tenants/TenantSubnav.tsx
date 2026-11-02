'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tenantPath, tenantUsersPath } from '@/lib/tenants-ui'

export function TenantSubnav({ id }: { id: string }) {
  const pathname = usePathname()
  const profile = tenantPath(id)
  const users = tenantUsersPath(id)
  const items = [
    { href: profile, label: 'Profile & settings', current: pathname === profile },
    { href: users, label: 'Users & access', current: pathname === users || Boolean(pathname?.startsWith(`${users}/`)) },
  ]
  return (
    <nav className="tenant-subnav" aria-label="Tenant sections">
      {items.map((item) => (
        <Link key={item.href} href={item.href} aria-current={item.current ? 'page' : undefined}>{item.label}</Link>
      ))}
    </nav>
  )
}
