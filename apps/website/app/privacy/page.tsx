import { SiteShell } from '../../components/layout/SiteShell'
import { privacyPolicyApproved } from '../../lib/legal-status'
import { siteConfig } from '../../lib/site-config'

export const metadata = {
  title: 'Privacy notice (draft)',
  description: 'Draft privacy information for the fBeds public website. Not yet legally approved.',
  robots: privacyPolicyApproved ? undefined : { index: false, follow: true },
}

type Section = { title: string; current: string; pending?: string }

// "current" states only behaviour that this website's code demonstrably has.
// "pending" lists business facts that the owner must supply; none are invented here.
const sections: Section[] = [
  {
    title: 'Information collected',
    current: 'If you use the enquiry form we receive your full name, business email, company, country or market, business type, estimated monthly volume, area of interest, your message and your confirmation of consent. A hidden anti-spam field is checked and discarded. If you email us instead, we receive what you send. The hosting provider also processes technical request data, such as IP address and browser details, to deliver and protect the site.',
    pending: 'Hosting provider name, the categories and retention of its request logs.',
  },
  {
    title: 'How information is used',
    current: 'Enquiry details are used to respond to your enquiry, which is the purpose stated beside the consent checkbox.',
    pending: 'Any other purpose (for example follow-up marketing) and the lawful basis for each purpose.',
  },
  {
    title: 'Cookies and analytics',
    current: 'This website’s own code does not set cookies. In production it loads Vercel Web Analytics, which records page views and these interaction events: primary call to action selected, portal link selected, demo form started, demo form validation failed, demo submission attempted and demo submission succeeded. Event data carries fixed interface context only; names, email addresses, company names and message contents are never included.',
    pending: 'Whether Vercel Web Analytics sets any cookie or persistent identifier on the plan in use, consent requirements by market, analytics retention, and whether to offer an opt-out.',
  },
  {
    title: 'Recipients and service providers',
    current: 'The website sends an enquiry online only when a receiving system is configured by the site operator; otherwise it tells you submission is not configured and shows the contact email address. When a receiver is configured, the website’s server sends your enquiry to it over HTTPS.',
    pending: 'Who operates the receiving system, every processor and sub-processor (hosting, analytics, email, CRM), and the agreements and safeguards in place.',
  },
  {
    title: 'Data retention',
    current: 'Retention periods have not been approved.',
    pending: 'Retention period for enquiries, for email correspondence and for hosting and analytics logs.',
  },
  {
    title: 'Data security',
    current: 'The site is served over HTTPS with security headers, and the enquiry form is validated on the server. No internet transmission or storage system can be guaranteed to be completely secure.',
  },
  {
    title: 'International transfers',
    current: 'Transfer arrangements have not been approved.',
    pending: 'Regions where data is processed and the transfer mechanism for each.',
  },
  {
    title: 'Your rights and choices',
    current: 'Depending on your location you may have rights to access, correct, delete, restrict or object to processing, and to withdraw consent. The process for exercising them has not been approved.',
    pending: 'Rights process, response times, privacy contact and supervisory authority details.',
  },
  {
    title: 'Changes to this notice',
    current: 'The effective date will be updated when an approved version is published.',
  },
]

export default function PrivacyPage() {
  return <SiteShell><section className="page-hero privacy-hero"><div className="container-wide"><p className="eyebrow">Legal</p><h1>Privacy notice (draft)</h1><p>This draft describes what the fBeds public website does today. It is not legal advice and has not been approved by legal or privacy counsel.</p><div className="privacy-meta"><strong>Status:</strong> Legal approval pending<br /><strong>Effective date:</strong> [Insert effective date]<br /><strong>Data controller:</strong> [Insert legal entity name and registered address]</div></div></section><section className="section-space"><div className="container-wide privacy-layout"><aside className="privacy-warning"><strong>Legal review required</strong><p>Items marked “Owner to confirm” need facts that this repository does not contain. Until they are supplied and approved, this page is excluded from search indexing and the sitemap.</p></aside><div className="privacy-content">{sections.map(({ title, current, pending }) => <section key={title}><h2>{title}</h2><p>{current}</p>{pending && <p className="privacy-pending"><strong>Owner to confirm:</strong> {pending}</p>}</section>)}<section><h2>Contact</h2><p>For general enquiries, email <a href={`mailto:${siteConfig.contactEmail}`}>{siteConfig.contactEmail}</a>.</p><p className="privacy-pending"><strong>Owner to confirm:</strong> a dedicated privacy contact, if different.</p></section></div></div></section></SiteShell>
}
