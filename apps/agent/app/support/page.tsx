import { PublicPage } from '@/components/entrance/trade-frame'
import { contactEmail, editorialPages } from '@/lib/marketplace-content'

export default function SupportPage() {
  const page = editorialPages.support
  return (
    <PublicPage kicker={page.kicker} title={page.title} summary={page.summary} sections={page.sections}>
      <p><a href={`mailto:${contactEmail}?subject=fBeds%20agent%20support`}>{contactEmail}</a></p>
    </PublicPage>
  )
}
