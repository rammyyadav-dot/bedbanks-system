import Link from 'next/link'

export function AgentPortal() {
  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-3 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-2">
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">Bedbanks System</p>
            <h1 className="text-3xl font-semibold tracking-tight">Agent Portal</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">Search-ready workspace for travel partners. Booking and supplier connectivity remain disabled in this shell.</p>
          </div>
          <Link className="text-sm font-medium text-primary underline-offset-4 hover:underline" href="/admin">Open Admin</Link>
        </header>
        <section className="grid gap-4 md:grid-cols-3">
          {[
            ['Workspace', 'Northstar Travel'],
            ['Access', 'Agent operator'],
            ['Environment', 'Preview / sandbox'],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-5 shadow-sm">
              <span className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
              <strong className="text-lg font-semibold">{value}</strong>
            </div>
          ))}
        </section>
        <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold">Portal foundation</h2>
            <p className="text-sm leading-6 text-muted-foreground">Tenant-aware navigation, role boundaries, and API contracts are ready for the next implementation phase.</p>
          </div>
        </section>
      </div>
    </main>
  )
}
