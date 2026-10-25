import type { ReactNode } from 'react'
import { BrandLogo } from '../brand/BrandLogo'

/** Shared frame for the public sign-in pages: blurred scene, white card, curved header. */
export function AuthCard({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <main className="supplier-login">
      <div className="login-scene" aria-hidden="true" />
      <section className="supplier-login-card" aria-labelledby="auth-title">
        <div className="login-card-head">
          <BrandLogo width={150} priority />
          <p className="supplier-brand-tag"><i />Supplier extranet</p>
          <svg viewBox="0 0 400 38" preserveAspectRatio="none" aria-hidden="true"><path d="M0 24 C 90 6, 230 2, 400 14 L400 38 L0 38 Z" fill="#ffffff" /><path d="M0 24 C 90 6, 230 2, 400 14" fill="none" stroke="#e3e6ea" strokeWidth="6" /></svg>
        </div>
        <div className="login-card-body">
          <h1 id="auth-title">{title}</h1>
          {lede && <p className="login-lede">{lede}</p>}
          {children}
        </div>
      </section>
    </main>
  )
}
