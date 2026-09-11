import { PortalFrame, PortalLinks } from '../components/site'
export const metadata = { title: 'Operations portal' }
export default function AdminPage() { return <PortalFrame kind="Operations"><main className="container-wide py-16 lg:py-24"><p className="eyebrow">Operations</p><h1 className="mt-4 max-w-2xl text-5xl font-extrabold tracking-[-.06em] text-ink sm:text-7xl">See the network clearly.</h1><p className="mt-6 max-w-xl text-lg leading-8 text-ink-muted">The operations experience is ready for connection to controls, mappings and booking health.</p><PortalLinks /></main></PortalFrame> }
