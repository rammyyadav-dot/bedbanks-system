import { PublicPage } from '@/components/entrance/trade-frame'
import { contactEmail, editorialPages } from '@/lib/marketplace-content'

export default function ContactPage() {
  const page = editorialPages.contact
  return (
    <PublicPage kicker={page.kicker} title={page.title} summary={page.summary} sections={page.sections}>
      <p><a href={`mailto:${contactEmail}`}>{contactEmail}</a></p>
    </PublicPage>
  )
}
