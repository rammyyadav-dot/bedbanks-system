export function ErrorState({ title = 'Unable to load data', description = 'Please try again.', reference, onRetry }: { title?: string; description?: string; reference?: string | null; onRetry?: () => void }) {
  return (
    <div className="admin-error" role="alert">
      <strong>{title}</strong>
      <span>{description}</span>
      {reference ? <span>Reference: <code>{reference}</code></span> : null}
      {onRetry ? <button type="button" className="admin-btn" onClick={onRetry}>Retry</button> : null}
    </div>
  );
}
