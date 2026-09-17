export function SectionHeading({ eyebrow, title, text, as = 'h2' }: { eyebrow: string; title: string; text?: string; as?: 'h1' | 'h2' }) {
  const Heading = as
  return <div className="section-heading"><p className="eyebrow">{eyebrow}</p><Heading>{title}</Heading>{text && <p>{text}</p>}</div>
}
