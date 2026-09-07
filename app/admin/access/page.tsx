import Link from 'next/link'

export default function AccessPage() {
  return (
    <section>
      <div className="page-header">
        <h1 className="text-2xl font-semibold">Access & Roles</h1>
        <p className="text-sm text-gray-500">Manage admin users, roles and permissions for the platform.</p>
      </div>

      <div className="mt-6 bg-white rounded shadow p-4">
        <p className="text-sm">This page is a scaffold. Add your user listing, role editor, and invite flows here.</p>
        <div className="mt-4">
          <Link href="/admin/access/invite" className="px-3 py-1 bg-blue-600 text-white rounded">Invite admin</Link>
        </div>
      </div>
    </section>
  )
}
