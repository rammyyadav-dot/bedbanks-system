import { contactEmail } from './marketplace-content.ts'

/**
 * Agent access request: the information fabBeds needs to review an agency.
 * Nothing here is sent to a server. The composer validates locally and opens the
 * visitor's own email client, so the page never claims a request was received.
 */
export const agencyTypes = ['Leisure travel agent', 'Corporate travel agent', 'DMC or groups', 'OTA', 'Wholesaler or reseller', 'Other'] as const
export const connectivityTypes = ['Booking website (agent portal)', 'API or XML connection', 'Both'] as const
export const volumeBands = ['Fewer than 100', '100–999', '1,000–9,999', '10,000 or more', 'Not yet known'] as const

export type AccessRequest = {
  firstName: string
  lastName: string
  jobTitle: string
  agencyName: string
  workEmail: string
  confirmEmail: string
  phone: string
  country: string
  agencyType: string
  agencyTypeOther: string
  connectivity: string
  website: string
  registrationNumber: string
  monthlyVolume: string
  comments: string
  consent: boolean
}
export type AccessField = keyof AccessRequest
export type AccessErrors = Partial<Record<AccessField, string>>

export const emptyAccessRequest: AccessRequest = {
  firstName: '', lastName: '', jobTitle: '', agencyName: '', workEmail: '', confirmEmail: '', phone: '', country: '',
  agencyType: '', agencyTypeOther: '', connectivity: '', website: '', registrationNumber: '', monthlyVolume: '', comments: '', consent: false,
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Consumer mailbox domains are not accepted as a work address for a trade account. */
const consumerDomains = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com'])
const phonePattern = /^\+?[0-9][0-9\s().-]{5,24}$/

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? ''
}

export function validateAccessRequest(input: AccessRequest): AccessErrors {
  const errors: AccessErrors = {}
  const text = (value: string) => value.trim()
  if (text(input.firstName).length < 1) errors.firstName = 'Enter your first name.'
  if (text(input.lastName).length < 1) errors.lastName = 'Enter your last name.'
  if (text(input.jobTitle).length < 2) errors.jobTitle = 'Enter your job title.'
  if (text(input.agencyName).length < 2) errors.agencyName = 'Enter your agency or company name.'
  if (!emailPattern.test(text(input.workEmail)) || text(input.workEmail).length > 254) errors.workEmail = 'Enter a valid work email address.'
  else if (consumerDomains.has(emailDomain(input.workEmail))) errors.workEmail = 'Use your agency email address. Personal mailboxes cannot be reviewed for a trade account.'
  if (!errors.workEmail && text(input.confirmEmail).toLowerCase() !== text(input.workEmail).toLowerCase()) errors.confirmEmail = 'The email addresses do not match.'
  if (!phonePattern.test(text(input.phone))) errors.phone = 'Enter a business phone number with country code, for example +971 4 000 0000.'
  if (text(input.country).length < 2) errors.country = 'Enter the country where your company is registered.'
  if (!agencyTypes.includes(input.agencyType as (typeof agencyTypes)[number])) errors.agencyType = 'Select your business type.'
  else if (input.agencyType === 'Other' && text(input.agencyTypeOther).length < 2) errors.agencyTypeOther = 'Describe your business type.'
  if (!connectivityTypes.includes(input.connectivity as (typeof connectivityTypes)[number])) errors.connectivity = 'Select how you plan to connect.'
  if (text(input.website) && !/^(https?:\/\/)?[^\s/]+\.[^\s/]+\S*$/i.test(text(input.website))) errors.website = 'Enter a valid website address, or leave it blank.'
  if (!volumeBands.includes(input.monthlyVolume as (typeof volumeBands)[number])) errors.monthlyVolume = 'Select an estimated monthly room-night volume.'
  if (text(input.comments).length > 1500) errors.comments = 'Keep comments below 1,500 characters.'
  if (!input.consent) errors.consent = 'Confirm that fabBeds may use these details to review your request.'
  return errors
}

/** Plain-text body for the visitor's own email client. Contains only what the visitor typed. */
export function composeAccessEmail(input: AccessRequest): { subject: string; body: string; href: string } {
  const text = (value: string) => value.trim() || '-'
  const type = input.agencyType === 'Other' ? `Other (${text(input.agencyTypeOther)})` : input.agencyType
  const subject = `Request agent access: ${text(input.agencyName)}`
  const body = [
    'Agency details',
    `Agency name: ${text(input.agencyName)}`,
    `Country registered in: ${text(input.country)}`,
    `Business type: ${type}`,
    `Website: ${text(input.website)}`,
    `Registered company number: ${text(input.registrationNumber)}`,
    '',
    'Contact',
    `Name: ${text(input.firstName)} ${text(input.lastName)}`.trim(),
    `Job title: ${text(input.jobTitle)}`,
    `Work email: ${text(input.workEmail)}`,
    `Business phone: ${text(input.phone)}`,
    '',
    'Trading',
    `Connectivity: ${text(input.connectivity)}`,
    `Estimated monthly room nights: ${text(input.monthlyVolume)}`,
    '',
    'Comments',
    text(input.comments),
  ].join('\n')
  return { subject, body, href: `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` }
}
