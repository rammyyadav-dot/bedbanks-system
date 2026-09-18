import { SiteShell } from '../../components/layout/SiteShell'

export const metadata = { title: 'Privacy policy', description: 'Privacy information for the fBeds public website.' }

const sections = [
  ['Information collected', 'We may collect information you submit through forms, information needed to respond to enquiries, and technical information generated when you use this website. Confirm the categories and sources with legal counsel before publication.'],
  ['How information is used', 'Information may be used to respond to requests, provide and improve website services, maintain security, and communicate about relevant fBeds services where permitted.'],
  ['Cookies and analytics', 'This website may use essential cookies and analytics technologies. Confirm the tools, consent requirements, retention periods and opt-out controls before publication.'],
  ['Sharing and service providers', 'Information may be shared with service providers that support hosting, analytics, communications or website operations, subject to appropriate agreements and safeguards.'],
  ['Data retention', 'We retain information only for as long as necessary for the stated purpose or as required by applicable law. Insert approved retention periods before publication.'],
  ['Data security', 'We use reasonable technical and organisational measures to protect information. No internet transmission or storage system can be guaranteed to be completely secure.'],
  ['International transfers', 'Information may be processed in countries outside your location. Insert the approved transfer mechanisms and regions before publication.'],
  ['User rights and choices', 'Depending on your location, you may have rights to access, correct, delete, restrict or object to processing, and to withdraw consent. Confirm the applicable process with legal counsel.'],
  ['Changes to this policy', 'We may update this policy from time to time. The effective date at the top of this page will be updated when changes are approved.'],
]

export default function PrivacyPage() {
  return <SiteShell><section className="page-hero privacy-hero"><div className="container-wide"><p className="eyebrow">Legal</p><h1>Privacy policy</h1><p>This draft explains how the fBeds public website may handle personal information. It is not legal advice and requires legal review before production publication.</p><div className="privacy-meta"><strong>Effective date:</strong> [Insert effective date]<br /><strong>Data controller:</strong> [Insert legal entity name]</div></div></section><section className="section-space"><div className="container-wide privacy-layout"><aside className="privacy-warning"><strong>Legal review required</strong><p>This page contains placeholders and must be reviewed and approved by the relevant legal or privacy owner before it is treated as the final policy.</p></aside><div className="privacy-content">{sections.map(([title, text]) => <section key={title}><h2>{title}</h2><p>{text}</p></section>)}<section><h2>Contact for privacy requests</h2><p>[Insert privacy email]</p></section></div></div></section></SiteShell>
}
