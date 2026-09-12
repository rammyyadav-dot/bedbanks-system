export function PermissionBadge({ granted }: { granted: boolean }) {
  return granted ? <span className="yes">✓</span> : <span className="no">–</span>;
}
