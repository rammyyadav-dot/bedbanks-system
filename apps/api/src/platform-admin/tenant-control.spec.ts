import { tenantReadiness } from './tenant-control.service'
import type { Prisma } from '@prisma/client'
const business = { name:'Business',country:'AE',address:'Address',city:'Dubai',businessEmail:'a@example.test',registrationNumber:'123',currency:'USD',markets:['AE'],channels:['B2B'],financeReviewed:true,classification:'BUYER' }
describe('Tenant activation readiness',()=>{
  it('fails closed for an absent profile and unverified owner',()=>{expect(tenantReadiness(null,0).every(r=>!r.ready)).toBe(true)})
  it('requires independent compliance and a verified owner',()=>{const profile={business:business as Prisma.JsonValue,complianceStatus:'PENDING'};expect(tenantReadiness(profile,0).filter(r=>!r.ready).map(r=>r.key)).toEqual(['administrator','compliance'])})
  it('does not equate supplier business preferences with distribution entitlement',()=>{const profile={business:{...business,classification:'SUPPLIER'} as Prisma.JsonValue,complianceStatus:'APPROVED'};expect(tenantReadiness(profile,1).filter(r=>!r.ready).map(r=>r.key)).toEqual(['distribution'])})
  it('allows only a fully recorded buyer profile to pass the current workflow',()=>{expect(tenantReadiness({business:business as Prisma.JsonValue,complianceStatus:'APPROVED'},1).every(r=>r.ready)).toBe(true)})
})
