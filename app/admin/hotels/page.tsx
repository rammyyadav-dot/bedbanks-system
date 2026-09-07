import Link from 'next/link'

const demo = [
  { id: 'H-1042', name: 'The Hoxton, Shoreditch', city: 'London, UK', status: 'Instant confirm' },
  { id: 'H-2981', name: 'CitizenM Tower of London', city: 'London, UK', status: 'Instant confirm' },
]

export default function HotelsPage() {
  return (
    <section>
      <div className="page-header">
        <h1 className="text-2xl font-semibold">Hotels</h1>
        <p className="text-sm text-gray-500">Manage hotel content, inventory mappings and supplier links.</p>
      </div>

      <div className="mt-6 bg-white rounded shadow p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-600">{demo.length} hotels</div>
          <div>
            <Link href="/admin/hotels/new" className="px-3 py-1 bg-blue-600 text-white rounded">Add hotel</Link>
          </div>
        </div>

        <ul className="mt-4 divide-y">
          {demo.map((h) => (
            <li key={h.id} className="py-3 flex justify-between items-center">
              <div>
                <div className="font-medium">{h.name}</div>
                <div className="text-sm text-gray-500">{h.city} · {h.id}</div>
              </div>
              <div className="text-sm text-gray-600">{h.status}</div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
