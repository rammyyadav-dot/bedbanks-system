import { RATE_CERTIFICATION_NOT_APPLICABLE, type HotelCertification, type MarkupRuleAudit, type RateCertificationSummary, type RemediationItem } from '@bedbanks/contracts'

const cell = (value: string | number): string => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
const REMEDIATION_ROWS = 100

/**
 * Deterministic Markdown audit report. It contains counts, hotel and plan names and finding codes only: no credentials, guest data or
 * raw supplier payloads. Every number is copied from the same scan the Admin page shows.
 */
export function renderMarkdownReport(input: { summary: RateCertificationSummary; hotels: HotelCertification[]; remediation: RemediationItem[]; markup: MarkupRuleAudit }): string {
  const { summary, hotels, remediation, markup } = input
  const out: string[] = []
  out.push('# Rate plan audit and distribution certification', '')
  out.push(`Generated ${summary.generatedAt} for ${summary.window.from} to ${summary.window.to} (${summary.window.days} nights).`)
  if (summary.scanCapped) out.push('', '> The hotel scan cap was reached; only the first hotels by name are included.')
  out.push('', 'This report is a read-only observation. It repaired, merged, deleted and published nothing.', '')
  out.push('## Summary', '', '| Measure | Count |', '| --- | --- |')
  out.push(`| Hotels assessed | ${summary.totals.hotels} |`, `| Rate plans | ${summary.totals.plans} |`, `| Live rate plans | ${summary.totals.livePlans} |`)
  out.push(`| Plans PASS / WARN / FAIL | ${summary.plans.PASS} / ${summary.plans.WARN} / ${summary.plans.FAIL} |`)
  out.push(`| Hotels CERTIFIED / READY WITH WARNINGS / NOT READY | ${summary.hotels.CERTIFIED} / ${summary.hotels.READY_WITH_WARNINGS} / ${summary.hotels.NOT_READY} |`)
  out.push(`| Remediation P0 / P1 / P2 | ${summary.remediation.P0} / ${summary.remediation.P1} / ${summary.remediation.P2} |`, `| ACTIVE markup rules | ${summary.markup.activeRules} |`, '')
  out.push('## Daily rate rows', '', '| Class | Rows |', '| --- | --- |')
  for (const [name, count] of Object.entries(summary.rowClasses)) out.push(`| ${name} | ${count} |`)
  out.push('', '## Findings', '', '| Code | Severity | Plans | Rows or nights |', '| --- | --- | --- | --- |')
  for (const f of summary.findings) out.push(`| ${f.code} | ${f.severity} | ${f.plans} | ${f.count} |`)
  if (summary.findings.length === 0) out.push('| none | | 0 | 0 |')
  out.push('', '## Hotels', '', '| Hotel | City | Status | Live plans | Blockers | Warnings |', '| --- | --- | --- | --- | --- | --- |')
  for (const h of hotels) out.push(`| ${cell(h.hotelName)} | ${cell(h.city)} | ${h.status} | ${h.plans.live} | ${cell(h.blockers.join('; '))} | ${cell(h.warnings.join('; '))} |`)
  out.push('', `## Remediation queue (first ${REMEDIATION_ROWS})`, '', '| Priority | Hotel | Plan | Code | Count | Suggested action |', '| --- | --- | --- | --- | --- | --- |')
  for (const i of remediation.slice(0, REMEDIATION_ROWS)) out.push(`| ${i.priority} | ${cell(i.hotelName)} | ${cell(i.ratePlanCode ?? '')} | ${i.code} | ${i.count} | ${cell(i.suggestedAction)} |`)
  if (remediation.length > REMEDIATION_ROWS) out.push('', `${remediation.length - REMEDIATION_ROWS} further items are in the JSON report.`)
  out.push('', '## Markup rules', '', `${markup.counts.total} rules: ${markup.counts.active} ACTIVE, ${markup.counts.draft} DRAFT, ${markup.counts.retired} RETIRED. NET plans with a night that has no applicable rule: ${markup.netPlansWithoutMarkup}.`)
  out.push('', '## Not applicable to fBeds', '', 'These concepts exist in other bedbank pricing specifications and are not part of this system. They are not reported as passed.', '')
  for (const item of RATE_CERTIFICATION_NOT_APPLICABLE) out.push(`- **${item.concept}**: ${item.reason}`)
  out.push('')
  return out.join('\n')
}
