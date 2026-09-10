export function LoadingState({ rows = 5 }: { rows?: number }) {
  return (
    <div className="workspace-panel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="admin-skeleton admin-skeleton-row" />
      ))}
    </div>
  );
}
