export default function AuditPage() {
  return (
    <section>
      <div className="page-header">
        <h1 className="text-2xl font-semibold">Audit Logs</h1>
        <p className="text-sm text-gray-500">View recent system events, operator actions and integrations.</p>
      </div>

      <div className="mt-6 bg-white rounded shadow p-4">
        <p className="text-sm">No logs to display yet. Hook up your audit event store (e.g. Postgres table, Elastic or third-party) and stream events here.</p>
      </div>
    </section>
  )
}
