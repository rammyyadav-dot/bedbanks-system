export function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
