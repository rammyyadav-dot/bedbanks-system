import { fileURLToPath } from 'node:url'

// Core infrastructure readiness gate.
// The default snapshot is the public observation recorded on 6 November 2026 (IST).
// `node tools/core-infra-readiness.mjs --probe` repeats the public DNS and HTTPS checks.
// It does not read secrets, call Neon, or call AWS.

export const OBSERVED_2026_11_06 = {
  capturedAt: '2026-11-06T06:05:00+05:30',
  nameservers: ['ns.rediffmailpro.com.', 'ns2.rediffmailpro.com.'],
  apexAddresses: ['119.252.154.32'],
  apexPtr: 'host-119-252-154-32.rediffdns.com.',
  apexOrg: 'AS38224 Rediff.com India Limited',
  apexHttpStatus: 200,
  apexTitle: 'Site Under Construction',
  wwwCname: 'd21ac37c94f744ea.vercel-dns-017.com.',
  wwwStatus: 404,
  wwwError: 'DEPLOYMENT_NOT_FOUND',
  wwwServer: 'Vercel',
  portalDns: {
    'agent.fbeds.com': 'NXDOMAIN',
    'admin.fbeds.com': 'NXDOMAIN',
    'supplier.fbeds.com': 'NXDOMAIN',
    'api.fbeds.com': 'NXDOMAIN',
  },
  responseHasCfRay: false,
  hostingerSeen: false,
  vercel: {
    projectCount: 1,
    projectId: 'prj_lVuB0DvJ2R8OAAEmtT1CqOi02eAI',
    projectName: 'bedbanks-system',
    live: false,
    teamOwnsFbedsCom: false,
    aliasTitles: {
      'fbeds-agent.vercel.app': 'fabbeds | The World\'s Wholesale Marketplace',
      'fbeds-admin.vercel.app': 'fabbeds | The World\'s Wholesale Marketplace',
      'fbeds-hotel-supplier.vercel.app': 'fabbeds | The World\'s Wholesale Marketplace',
    },
    aliasCanonical: 'https://www.fabbeds.io',
    latestProductionState: 'CANCELED',
    latestProductionSkipDoc: 'https://vercel.com/docs/monorepos#skipping-unaffected-projects',
    latestReadySha: 'b909c8f99541e9e175a3403eb5bea48ff3cf669c',
    latestReadyDeployment: 'dpl_32ZpEeYTnHrQeLMePTNCAm5KvgF8',
  },
  awsApplyRecorded: false,
  databaseOwnerSigned: false,
  neonContacted: false,
  bookingCertifiedLive: false,
  searchBudgetMet: false,
}

const MARKETING = 'fabbeds | The World\'s Wholesale Marketplace'

export function hostingSplit(obs) {
  const ns = obs.nameservers.join(', ')
  return [
    { role: 'Authoritative DNS', provider: 'Rediff Mail Pro', evidence: ns, label: 'verified' },
    { role: 'Apex web (fbeds.com)', provider: 'Rediff shared hosting, Mumbai', evidence: `${obs.apexPtr} ${obs.apexOrg}; HTTP ${obs.apexHttpStatus} “${obs.apexTitle}”`, label: 'verified' },
    { role: 'www.fbeds.com', provider: 'DNS CNAME to Vercel; no deployment on that hostname', evidence: `${obs.wwwCname} HTTP ${obs.wwwStatus} ${obs.wwwError}`, label: 'verified' },
    { role: 'Agent, Admin, Supplier hostnames', provider: 'No public DNS records', evidence: Object.entries(obs.portalDns).map(([h, s]) => `${h} ${s}`).join('; '), label: 'verified' },
    { role: 'Portal aliases currently answering', provider: 'One Vercel project serving the marketing site on every alias', evidence: `${obs.vercel.projectName} (${obs.vercel.projectId}); canonical ${obs.vercel.aliasCanonical}`, label: 'verified' },
    { role: 'API compute', provider: 'Not identified on the public internet', evidence: 'api.fbeds.com NXDOMAIN. Render blueprint is autoDeploy:false. AWS ECS is Terraform only.', label: 'needs_access' },
    { role: 'Database', provider: 'Neon is the documented source until an RDS cutover (ADR 0079). RDS is not applied.', evidence: obs.neonContacted ? 'Neon API contacted' : 'Neon was not contacted in this review', label: obs.neonContacted ? 'verified' : 'needs_access' },
    { role: 'Hostinger', provider: 'No hosting role found', evidence: obs.hostingerSeen ? 'name seen' : 'Absent from DNS, HTTP, and the repository infrastructure', label: 'verified' },
    { role: 'Cloudflare', provider: 'Not the DNS host and not the HTTP proxy', evidence: obs.responseHasCfRay ? 'cf-ray present' : 'No Cloudflare nameserver and no cf-ray on www or the apex', label: 'verified' },
    { role: 'AWS', provider: 'Target production platform (ADR 0040, 0055, 0079). Not the current public host.', evidence: obs.awsApplyRecorded ? 'apply recorded' : 'No apply, plan, or account audit in this review', label: obs.awsApplyRecorded ? 'verified' : 'needs_access' },
  ]
}

export function assess(obs) {
  const aliasTitles = Object.values(obs.vercel.aliasTitles)
  const portalsAreMarketing = aliasTitles.length > 0 && aliasTitles.every((t) => t === MARKETING)
  const findings = [
    finding('public-www', 'Public website', obs.wwwStatus === 200 && obs.wwwError == null, true, 'www.fbeds.com returns the application over HTTPS', `${obs.wwwServer} HTTP ${obs.wwwStatus} ${obs.wwwError ?? ''}`.trim()),
    finding('public-apex', 'Apex site', obs.apexTitle !== 'Site Under Construction', true, 'fbeds.com is not the registrar placeholder', obs.apexTitle),
    finding('portal-dns', 'Portal DNS', Object.values(obs.portalDns).every((s) => s !== 'NXDOMAIN'), true, 'agent, admin, and supplier names resolve', JSON.stringify(obs.portalDns)),
    finding('portal-apps', 'Portal applications', obs.vercel.projectCount >= 4 && !portalsAreMarketing, true, 'Agent, Admin, and Supplier are separate applications', `projects=${obs.vercel.projectCount}; titles=${aliasTitles.join(' | ')}`),
    finding('vercel-follow', 'Vercel promotion', obs.vercel.latestProductionState === 'READY' && obs.vercel.live === true, true, 'The newest production deployment is Ready and the project is live', `${obs.vercel.latestProductionState}; live=${obs.vercel.live}; last Ready ${obs.vercel.latestReadySha}`),
    finding('dns-authority', 'DNS authority', obs.nameservers.length > 0, false, 'Authoritative nameservers were observed', obs.nameservers.join(', ')),
    finding('cloudflare', 'Cloudflare', obs.responseHasCfRay, false, 'Cloudflare is on the public request path', obs.responseHasCfRay ? 'cf-ray present' : 'not in the path'),
    finding('hostinger', 'Hostinger', obs.hostingerSeen, false, 'Hostinger is serving a named role', obs.hostingerSeen ? 'seen' : 'not seen'),
    finding('aws', 'AWS', obs.awsApplyRecorded, true, 'A reviewed AWS apply exists', obs.awsApplyRecorded ? 'recorded' : 'not recorded'),
    finding('database', 'Database', obs.databaseOwnerSigned, true, 'The database owner has signed the production checklist', obs.neonContacted ? 'Neon contacted' : 'Neon not contacted; checklist unsigned'),
    finding('search-budget', 'Search performance', obs.searchBudgetMet, true, 'Hybrid search p95 and p99 are under 200 ms on a production-shaped corpus', obs.searchBudgetMet ? 'met' : 'open since the 2026-11-02 certification'),
    finding('booking', 'Live booking', obs.bookingCertifiedLive, true, 'Booking is enabled only with a named certification', obs.bookingCertifiedLive ? 'certified' : 'fail-closed; not certified live'),
  ]
  const blocking = findings.filter((f) => !f.ok && f.blocking)
  return {
    reportedCompletionSupported: blocking.length === 0,
    onTrackSupported: blocking.length === 0,
    blocking: blocking.map((f) => f.id),
    findings,
    split: hostingSplit(obs),
  }
}

function finding(id, component, ok, blocking, expectation, detail) {
  return { id, component, ok: Boolean(ok), blocking, expectation, detail }
}

export async function probePublicSurface() {
  const doh = async (name, type) => {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`
    const res = await fetch(url, { headers: { accept: 'application/dns-json' } })
    if (!res.ok) throw new Error(`DNS query failed for ${name} ${type}`)
    return res.json()
  }
  const answers = (payload, type) => (payload.Answer ?? []).filter((a) => a.type === type).map((a) => a.data)
  const ns = await doh('fbeds.com', 'NS')
  const a = await doh('fbeds.com', 'A')
  const www = await doh('www.fbeds.com', 'CNAME')
  const portals = {}
  for (const host of ['agent.fbeds.com', 'admin.fbeds.com', 'supplier.fbeds.com', 'api.fbeds.com']) {
    const rec = await doh(host, 'A')
    portals[host] = rec.Status === 3 ? 'NXDOMAIN' : 'present'
  }
  return {
    nameservers: answers(ns, 2),
    apexAddresses: answers(a, 1),
    wwwCname: answers(www, 5)[0] ?? null,
    portalDns: portals,
  }
}

function report(result) {
  console.log(`reported 92% supported: ${result.reportedCompletionSupported}`)
  console.log(`on track supported: ${result.onTrackSupported}`)
  console.log(`blocking: ${result.blocking.join(', ') || 'none'}`)
  for (const row of result.split) console.log(`${row.label}\t${row.role}\t${row.provider}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--probe')) {
    const live = await probePublicSurface()
    console.log(JSON.stringify(live, null, 2))
  } else {
    report(assess(OBSERVED_2026_11_06))
  }
}
