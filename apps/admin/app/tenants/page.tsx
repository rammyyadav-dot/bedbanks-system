import Link from 'next/link'

const tenants = [
  { code: 'TRV-001', name: 'Travel Republic', tier: 'Gold', balance: '$184,290' },
  { code: 'AGT-093', name: 'Atlas Getaways', tier: 'Silver', balance: '$64,820' },
]

export default function TenantsPage() {
  return (
    <section>
      <div className="page-header">
        <h1 className="text-2xl font-semibold">Tenants</h1>
        <p className="text-sm text-gray-500">Workspace tenants, billing and API status.</p>
      </div>

      <div className="mt-6 bg-white rounded shadow p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-600">{tenants.length} tenants</div>
          <div>
            <Link href="/tenants/new" className="px-3 py-1 bg-blue-600 text-white rounded">Create tenant</Link>
          </div>
        </div>

        <ul className="mt-4 divide-y">
          {tenants.map((t) => (
            <li key={t.code} className="py-3 flex justify-between items-center">
              <div>
                <div className="font-medium">{t.name}</div>
                <div className="text-sm text-gray-500">{t.code} · {t.tier}</div>
              </div>
              <div className="text-sm text-gray-600">{t.balance}</div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
