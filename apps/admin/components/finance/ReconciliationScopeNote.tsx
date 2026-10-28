/** Honest scope statement shown under the statements table, so the screen never reads as a payment or posting capability (ADR 0070). */
export function ReconciliationScopeNote() {
  return <p style={{ fontSize: 11, color: 'var(--c-6b6b6b)', margin: '10px 0 0' }}>Matching compares booking references and exact supplier net amounts. It never converts currencies and never posts to the ledger or pays a supplier: decisions are recorded for finance to act on.</p>
}
