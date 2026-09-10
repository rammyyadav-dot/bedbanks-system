'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { Tabs } from '@/components/common/Tabs'

function Simulator() {
  const [cost, setCost] = useState(400)
  const [markup, setMarkup] = useState(18)
  const [tax, setTax] = useState(5)
  const [fee, setFee] = useState(8)
  const [discount, setDiscount] = useState(0)

  const markupAmount = cost * (markup / 100)
  const subtotal = cost + markupAmount
  const taxAmount = subtotal * (tax / 100)
  const finalRate = subtotal + taxAmount + fee - discount

  const field = (label: string, value: number, setter: (v: number) => void, suffix = '') => (
    <label className="admin-login-field">
      <span>{label}{suffix ? ` (${suffix})` : ''}</span>
      <input type="number" value={value} onChange={(e) => setter(Number(e.target.value))} />
    </label>
  )

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <div className="workspace-panel" style={{ padding: 18 }}>
        {field('Supplier Cost', cost, setCost, 'USD')}
        {field('Markup', markup, setMarkup, '%')}
        {field('Tax', tax, setTax, '%')}
        {field('Service Fee', fee, setFee, 'USD')}
        {field('Discount', discount, setDiscount, 'USD')}
      </div>
      <div className="workspace-panel" style={{ padding: 18 }}>
        <div style={{ fontSize: 10, color: '#8ba0a5', marginBottom: 12, fontFamily: "'Courier New', monospace" }}>MOCK CALCULATION — NOT PRODUCTION PRICING LOGIC</div>
        {[
          ['Supplier Cost', cost], ['Markup', markupAmount], ['Tax', taxAmount], ['Service Fee', fee], ['Discount', -discount],
        ].map(([label, val]) => (
          <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #edf2f3', fontSize: 12 }}>
            <span style={{ color: '#7c949a' }}>{label}</span><span style={{ color: '#2c4a55', fontWeight: 600 }}>${(val as number).toFixed(2)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0 0', fontSize: 15 }}>
          <strong>Final Sell Rate</strong><strong style={{ color: '#0d2631' }}>${finalRate.toFixed(2)}</strong>
        </div>
      </div>
    </div>
  )
}

export default function PricingPage() {
  return (
    <div className="admin-page">
      <PageHeader eyebrow="PRICING" title="Pricing" description="Rules, markups, taxes/fees, and a live pricing simulator. All mock — no production pricing logic runs here." />
      <Tabs tabs={[
        { id: 'rules', label: 'Pricing Rules', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Default markup: 18% · Applies to all suppliers unless overridden by contract (mock rule).</div> },
        { id: 'markups', label: 'Markups', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Per-supplier markup overrides — see Contracts module for actual values.</div> },
        { id: 'taxes', label: 'Taxes & Fees', content: <div className="workspace-panel" style={{ padding: 18, fontSize: 12, color: '#4a6a73' }}>Standard tax: 5% · Service fee: $8 flat (mock defaults).</div> },
        { id: 'simulator', label: 'Pricing Simulator', content: <Simulator /> },
      ]} />
    </div>
  )
}
