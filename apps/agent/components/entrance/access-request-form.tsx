'use client'

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { accessCopy } from '@/lib/marketplace-content'
import {
  agencyTypes, composeAccessEmail, connectivityTypes, emptyAccessRequest, validateAccessRequest, volumeBands,
  type AccessErrors, type AccessField, type AccessRequest,
} from '@/lib/access-request'

type Sent = { href: string; subject: string; body: string }

export function AccessRequestForm() {
  const [values, setValues] = useState<AccessRequest>(emptyAccessRequest)
  const [errors, setErrors] = useState<AccessErrors>({})
  const [sent, setSent] = useState<Sent | null>(null)
  const summary = useRef<HTMLDivElement>(null)

  const set = (field: AccessField) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const value = event.target instanceof HTMLInputElement && event.target.type === 'checkbox' ? event.target.checked : event.target.value
    setValues((current) => ({ ...current, [field]: value }))
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = validateAccessRequest(values)
    setErrors(found)
    if (Object.keys(found).length) { queueMicrotask(() => summary.current?.focus()); return }
    const email = composeAccessEmail(values)
    setSent(email)
    window.location.href = email.href
  }

  const field = (name: AccessField, label: string, props: { type?: string; autoComplete?: string; placeholder?: string; required?: boolean; hint?: string } = {}) => (
    <label className="access-field" htmlFor={`access-${name}`}>
      <span>{label}{props.required ? ' *' : ''}</span>
      <input
        id={`access-${name}`} name={name} type={props.type ?? 'text'} autoComplete={props.autoComplete} placeholder={props.placeholder}
        value={values[name] as string} onChange={set(name)} aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `access-${name}-error` : props.hint ? `access-${name}-hint` : undefined}
        maxLength={254}
      />
      {props.hint && !errors[name] ? <small id={`access-${name}-hint`}>{props.hint}</small> : null}
      {errors[name] ? <small className="access-error" id={`access-${name}-error`}>{errors[name]}</small> : null}
    </label>
  )

  const radios = (name: 'agencyType' | 'connectivity', legend: string, options: readonly string[]) => (
    <fieldset className="access-choice" aria-describedby={errors[name] ? `access-${name}-error` : undefined}>
      <legend>{legend} *</legend>
      {options.map((option) => (
        <label key={option}><input type="radio" name={name} value={option} checked={values[name] === option} onChange={set(name)} /> {option}</label>
      ))}
      {errors[name] ? <small className="access-error" id={`access-${name}-error`}>{errors[name]}</small> : null}
    </fieldset>
  )

  const messages = Object.values(errors).filter(Boolean)

  if (sent) {
    return (
      <div className="access-sent" role="status">
        <h2>{accessCopy.successTitle}</h2>
        <p>{accessCopy.successText}</p>
        <pre tabIndex={0} aria-label="Request text to copy">{`To: hello@fbeds.com\nSubject: ${sent.subject}\n\n${sent.body}`}</pre>
        <p><a className="trade-button" href={sent.href}>Open email again</a> <button type="button" className="trade-button is-secondary" onClick={() => setSent(null)}>Edit details</button></p>
      </div>
    )
  }

  return (
    <form className="access-form" onSubmit={submit} noValidate aria-labelledby="access-form-title">
      <h2 id="access-form-title">Agency information</h2>
      {messages.length ? (
        <div className="trade-banner is-error" role="alert" tabIndex={-1} ref={summary}>
          <strong>Please fix {messages.length === 1 ? 'one field' : `${messages.length} fields`} before sending.</strong>
          <ul>{messages.map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      ) : null}

      <div className="access-grid">
        {field('firstName', 'First name', { required: true, autoComplete: 'given-name' })}
        {field('lastName', 'Last name', { required: true, autoComplete: 'family-name' })}
        {field('jobTitle', 'Job title', { required: true, autoComplete: 'organization-title' })}
        {field('agencyName', 'Agency or company name', { required: true, autoComplete: 'organization' })}
        {field('workEmail', 'Work email', { required: true, type: 'email', autoComplete: 'email', placeholder: 'you@youragency.com', hint: 'Use your agency domain. Personal mailboxes are not reviewed.' })}
        {field('confirmEmail', 'Repeat work email', { required: true, type: 'email', autoComplete: 'off', placeholder: 'you@youragency.com' })}
        {field('phone', 'Business phone', { required: true, type: 'tel', autoComplete: 'tel', placeholder: '+971 4 000 0000' })}
        {field('country', 'Country your company is registered in', { required: true, autoComplete: 'country-name' })}
      </div>

      <div className="access-grid">
        {radios('agencyType', 'Business type', agencyTypes)}
        {radios('connectivity', 'How will you connect?', connectivityTypes)}
      </div>
      {values.agencyType === 'Other' ? field('agencyTypeOther', 'Business type, if Other', { required: true }) : null}

      <div className="access-grid">
        {field('website', 'Company website', { type: 'url', autoComplete: 'url', placeholder: 'www.youragency.com' })}
        {field('registrationNumber', 'Registered company number', { hint: 'Optional now. We may ask for it, and your trade licence, during review.' })}
        <label className="access-field" htmlFor="access-monthlyVolume">
          <span>Estimated monthly room nights *</span>
          <select id="access-monthlyVolume" name="monthlyVolume" value={values.monthlyVolume} onChange={set('monthlyVolume')} aria-invalid={errors.monthlyVolume ? true : undefined}>
            <option value="">Select a range</option>
            {volumeBands.map((band) => <option key={band} value={band}>{band}</option>)}
          </select>
          {errors.monthlyVolume ? <small className="access-error">{errors.monthlyVolume}</small> : null}
        </label>
      </div>

      <h2>Comments or questions</h2>
      <label className="access-field" htmlFor="access-comments">
        <span>Comments</span>
        <textarea id="access-comments" name="comments" rows={5} maxLength={1500} value={values.comments} onChange={set('comments')} placeholder="Markets you sell, destinations you need, anything we should know." />
        {errors.comments ? <small className="access-error">{errors.comments}</small> : null}
      </label>
      <p className="access-warning">Do not enter passwords, card numbers or guest details.</p>

      <label className="access-consent">
        <input type="checkbox" name="consent" checked={values.consent} onChange={set('consent')} aria-invalid={errors.consent ? true : undefined} />
        <span>I agree that fabBeds may use these details to review my agency and contact me about it. *</span>
      </label>
      {errors.consent ? <small className="access-error">{errors.consent}</small> : null}

      <p className="trade-muted">{accessCopy.privacyNote}</p>
      <button type="submit" className="trade-button">Prepare request email</button>
    </form>
  )
}
