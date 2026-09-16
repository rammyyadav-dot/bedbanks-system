import { SupplierShell } from '../../components/layout/SupplierShell'

export default function PortalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SupplierShell>{children}</SupplierShell>
}
