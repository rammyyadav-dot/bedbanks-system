'use client'
import { track } from '@vercel/analytics'
export type WebsiteEvent = 'primary_cta_selected' | 'portal_link_selected' | 'demo_form_started' | 'demo_form_validation_failed' | 'demo_submission_attempted' | 'demo_submission_succeeded'
export function trackWebsiteEvent(name: WebsiteEvent, properties?: Record<string, string>) { try { track(name, properties) } catch { /* Analytics cannot block the page. */ } }
