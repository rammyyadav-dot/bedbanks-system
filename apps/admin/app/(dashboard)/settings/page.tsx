import { PageHeader } from '@/components/common/PageHeader'
import { Tabs } from '@/components/common/Tabs'
import { FormField } from '@/components/forms/FormField'

function SettingsForm({ children }: { children: React.ReactNode }) {
  return <div className="workspace-panel" style={{ padding: 18, maxWidth: 480 }}>{children}</div>
}

export default function SettingsPage() {
  return (
    <div className="admin-page">
      <PageHeader eyebrow="SETTINGS" title="Settings" description="Platform, regional, and system configuration. UI-only — nothing persists yet." />
      <Tabs tabs={[
        { id: 'platform', label: 'Platform', content: <SettingsForm><FormField label="PLATFORM NAME"><input defaultValue="FBEDS" /></FormField><FormField label="SUPPORT EMAIL"><input defaultValue="support@yourbedbank.com" /></FormField></SettingsForm> },
        { id: 'general', label: 'General', content: <SettingsForm><FormField label="DEFAULT LANGUAGE"><select defaultValue="en"><option value="en">English</option></select></FormField></SettingsForm> },
        { id: 'regional', label: 'Regional', content: <SettingsForm><FormField label="TIME ZONE"><select defaultValue="utc"><option value="utc">UTC</option></select></FormField></SettingsForm> },
        { id: 'currency', label: 'Currency', content: <SettingsForm><FormField label="BASE CURRENCY"><select defaultValue="usd"><option value="usd">USD</option></select></FormField></SettingsForm> },
        { id: 'notifications', label: 'Notifications', content: <SettingsForm><FormField label="LOW BALANCE THRESHOLD"><input type="number" defaultValue={1000} /></FormField></SettingsForm> },
        { id: 'system', label: 'System', content: <SettingsForm><FormField label="API BASE URL"><input defaultValue="/api/v1" disabled /></FormField></SettingsForm> },
      ]} />
    </div>
  )
}
