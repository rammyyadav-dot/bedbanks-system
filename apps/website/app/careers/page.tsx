import { ArrowUpRight, Check } from 'lucide-react'
import { SiteShell } from '../../components/layout/SiteShell'
import { siteConfig } from '../../lib/site-config'

export const metadata = { title: 'Careers', description: 'Build the future of global hotel distribution with fBeds.' }

const values = [
  ['Ownership', 'Take responsibility for the outcomes our partners and teammates rely on.'],
  ['Curiosity', 'Ask better questions, learn quickly and stay close to the real travel workflow.'],
  ['Partner focus', 'Build with empathy for the hotels, suppliers and buyers we connect.'],
  ['High standards', 'Make the dependable, thoughtful choice even when the work is complex.'],
]

export default function CareersPage() {
  return <SiteShell><section className="page-hero"><div className="container-wide"><p className="eyebrow">Careers at fBeds</p><h1>Build the future of global hotel distribution.</h1><p>We are building travel technology that makes a measurable commercial difference. Our work brings together product thinking, operational craft and the relationships that keep global hospitality moving.</p></div></section><section className="section-space"><div className="container-wide"><div className="section-heading"><p className="eyebrow">How we work</p><h2>Make complex systems feel useful.</h2><p>We value collaboration across disciplines, direct communication and a practical bias toward better partner outcomes.</p></div><div className="four-column">{values.map(([title, text]) => <article className="icon-card" key={title}><Check aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div></div></section><section className="panel-section"><div className="container-wide careers-openings"><div><p className="eyebrow">Open roles</p><h2>We are growing our team.</h2><p>There are no verified public vacancies listed at this time. Share your profile and tell us where you can make an impact.</p></div><a className="button button-primary" href={`mailto:${siteConfig.contactEmail}?subject=Future%20opportunities%20at%20fBeds`}>Share your profile <ArrowUpRight size={16} aria-hidden="true" /></a></div></section></SiteShell>
}
