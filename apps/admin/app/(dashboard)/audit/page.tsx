import { FeatureUnavailable } from '@/components/common/FeatureUnavailable'

export default function Page() {
  return <FeatureUnavailable eyebrow="CONTROL · AUDIT" title="Audit" reason="Audit events are recorded for every privileged mutation, but no authoritative Admin audit-read endpoint exists yet, so no events are shown." gap="P1 — add a tenant-scoped, permission-guarded audit read API and connect this page."/>
}
