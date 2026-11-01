import { PublicPage } from '@/components/entrance/trade-frame'
import { editorialPages } from '@/lib/marketplace-content'

export default function NewsPage() {
  const page = editorialPages.news
  return <PublicPage kicker={page.kicker} title={page.title} summary={page.summary} sections={page.sections} />
}
