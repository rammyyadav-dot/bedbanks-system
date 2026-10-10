import type { ReactNode } from 'react'
import Link from 'next/link'
import { HOTEL_CONTACT_KINDS, HOTEL_POLICY_KEYS, HOTEL_POLICY_LABELS, type HotelSetupView } from '@bedbanks/contracts'
import { when } from '@/components/ops/ops-ui'
import { hotelHref, starsText } from '@/lib/hotel-ui'
import styles from './HotelProfile.module.css'

export function ProfileCard({ title, children, hotelId, tab, action = 'View / edit' }: { title: string; children: ReactNode; hotelId: string; tab?: Parameters<typeof hotelHref>[1]; action?: string }) {
  return <section className={`workspace-panel ${styles.card}`} aria-label={title}>
    <div className={styles.heading}><h2>{title}</h2>{tab && <Link href={hotelHref(hotelId, tab)} aria-label={`${action} ${title.toLowerCase()}`}>{action}</Link>}</div>
    {children}
  </section>
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === null || value === undefined || value === '' ? 'Not recorded' : value}</dd></div>)}</dl>
}

/** Saved profile only. Publication/commercial eligibility remains an API decision. Private fields are never inferred. */
export function HotelProfile({ setup: s, canManage }: { setup: HotelSetupView; canManage: boolean }) {
  const id = s.hotelId
  return <div className={styles.grid} data-testid="hotel-profile">
    <ProfileCard title="Hotel identity" hotelId={id} tab="setup" action={canManage ? 'Edit' : 'View'}>
      <Facts rows={[
        ['Hotel name', s.identity.name], ['Property type', s.identity.propertyType], ['Legal name', s.identity.legalName],
        ['Chain', s.identity.chainName], ['Brand', s.identity.brandName], ['Hotel code', s.identity.code], ['Canonical ID', <code key="id">{id}</code>],
        ['Star category', starsText(s.classification.starRating)], ['Category verification', s.classification.verified ? 'Verified' : 'Not verified'],
        ['Category source', s.classification.source], ['Verified at', s.classification.verifiedAt ? when(s.classification.verifiedAt) : null],
      ]} />
      <h3 className={styles.subheading}>External identifiers</h3>
      {s.identity.externalIdentifiers.length ? <Facts rows={s.identity.externalIdentifiers.map(i => [i.scheme, i.value])} /> : <p className={styles.note}>No external identifiers recorded.</p>}
    </ProfileCard>
    <ProfileCard title="Location" hotelId={id} tab="setup" action={canManage ? 'Edit' : 'View'}>
      <Facts rows={[
        ['Country', s.location.countryCode], ['City', s.location.city], ['Area', s.location.area], ['Street address', s.location.address],
        ['Postal code', s.location.postalCode], ['Latitude', s.location.latitude], ['Longitude', s.location.longitude], ['Time zone', s.location.timeZone],
      ]} />
    </ProfileCard>
    <ProfileCard title="Hotel description" hotelId={id} tab="setup" action={canManage ? 'Edit' : 'View'}>
      <p className={styles.text}>{s.content.shortDescription || 'No short description recorded.'}</p>
      <h3 className={styles.subheading}>Full description</h3>
      <p className={styles.text}>{s.content.fullDescription || 'No full description recorded.'}</p>
      <p className={styles.note}>Content languages: {s.content.languages.length ? s.content.languages.join(', ') : 'Not recorded'}</p>
    </ProfileCard>
    <ProfileCard title="Hotel operations" hotelId={id} tab="setup" action={canManage ? 'Edit' : 'View'}>
      <Facts rows={[
        ['Check-in time', s.operations.checkInTime], ['Check-out time', s.operations.checkOutTime], ['Hotel time zone', s.location.timeZone], ['Operational notes', s.operations.notes],
      ]} />
      <p className={styles.note}>Times are local to the hotel.</p>
    </ProfileCard>
    <ProfileCard title="Hotel policies" hotelId={id} tab="policies">
      <Facts rows={HOTEL_POLICY_KEYS.map(key => [HOTEL_POLICY_LABELS[key], s.policies[key]])} />
      <p className={styles.note}>Hotel information only. Cancellation terms for an offer come from its contract and rate plan.</p>
    </ProfileCard>
    <ProfileCard title="Private contacts" hotelId={id} tab={canManage ? 'setup' : undefined} action="Edit">
      {s.contacts === null || !canManage ? <p className={styles.note} data-testid="overview-contacts-hidden">Private contacts require hotel management permission.</p> : <div className={styles.contacts}>
        {HOTEL_CONTACT_KINDS.map(kind => <div key={kind}><h3>{kind}</h3><Facts rows={[
          ['Name', s.contacts?.[kind]?.name], ['Email', s.contacts?.[kind]?.email], ['Phone', s.contacts?.[kind]?.phone],
        ]} /></div>)}
      </div>}
    </ProfileCard>
    <ProfileCard title="Profile governance" hotelId={id} tab="setup" action="View">
      <Facts rows={[
        ['Profile status', s.governance.status], ['Source system', s.governance.sourceSystem],
        ['Internal owner', canManage && s.governance.owner ? `${s.governance.owner.name || 'Unnamed member'} (${s.governance.owner.email})` : s.governance.ownerUserId ? 'Assigned member' : null],
        ['Approved at', s.governance.approvedAt ? when(s.governance.approvedAt) : null], ['Last saved', when(s.governance.updatedAt)],
        ['Publication request', s.publication ? `${s.publication.status}${s.publication.changedSinceRequest ? ' · profile changed since request' : ''}` : 'No open request'],
      ]} />
      <p className={styles.note}>{s.profileExists ? 'Saved hotel profile.' : 'No extended profile saved yet. Open Hotel Setup to complete it.'}</p>
    </ProfileCard>
  </div>
}
