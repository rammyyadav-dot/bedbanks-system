import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { SiteShell } from '../../components/layout/SiteShell'
import { CTA } from '../../components/sections/CTA'
import { audiences } from '../../lib/content'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Solutions for hotel-distribution businesses', description: 'Explore fBeds workflows for travel agencies, tour operators, DMCs, hotels and travel-technology teams.', path: '/solutions' })
export default function SolutionsPage() { return <SiteShell><section className="container-wide page-hero"><div><p className="eyebrow">Solutions</p><h1>Hotel distribution starts with different responsibilities.</h1><p>Choose the operating model closest to your team and see how fBeds approaches its content, commercial and booking workflows.</p></div></section><section className="container-wide section-space"><div className="audience-grid">{audiences.map(({ icon: Icon, ...item }) => <Link href={item.href} className="audience-card" key={item.href}><Icon aria-hidden="true" /><h2>{item.title}</h2><p>{item.text}</p><span>Explore solution <ArrowUpRight aria-hidden="true" /></span></Link>)}</div></section><CTA /></SiteShell> }
