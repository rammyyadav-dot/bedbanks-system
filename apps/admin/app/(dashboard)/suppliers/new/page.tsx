import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { SupplierForm } from '@/components/commercial/SupplierForm'

export default function NewSupplierPage() {
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · SUPPLIERS" title="New supplier" description="Create a supplier in DRAFT or set it ACTIVE once its commercial relationship is confirmed." actions={<Link href="/suppliers" className="admin-btn">Back to suppliers</Link>} />
      <SupplierForm />
    </div>
  )
}
