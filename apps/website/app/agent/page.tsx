import { PortalFrame, PortalLinks } from '../components/site'
export const metadata = { title: 'Agent portal' }
export default function AgentPage() { return <PortalFrame kind="Agent"><main className="container-wide py-16 lg:py-24"><p className="eyebrow">Travel sellers</p><h1 className="mt-4 max-w-2xl text-5xl font-extrabold tracking-[-.06em] text-ink sm:text-7xl">Search, compare and book with clarity.</h1><p className="mt-6 max-w-xl text-lg leading-8 text-ink-muted">The agent experience is ready for connection to your authenticated booking workspace.</p><PortalLinks /></main></PortalFrame> }
