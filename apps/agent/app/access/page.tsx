import { PublicPage } from '@/components/entrance/trade-frame'
import { contactEmail, editorialPages } from '@/lib/marketplace-content'

export default function AccessPage() {
  const page = editorialPages.access
  const mailto = `mailto:${contactEmail}?subject=${encodeURIComponent('Request agent access')}&body=${encodeURIComponent('Agency name:\nContact name:\nWork email:\nMarket:\n')}`
  return (
    <PublicPage kicker={page.kicker} title={page.title} summary={page.summary} sections={page.sections}>
      <p>Online enquiry submission is not configured, so this page does not send the request for you.</p>
      <p><a className="trade-button" href={mailto}>Email {contactEmail}</a></p>
    </PublicPage>
  )
}
