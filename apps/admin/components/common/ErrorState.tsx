export function ErrorState({ title = 'Unable to load data', description = 'Please try again.' }: { title?: string; description?: string }) {
  return (
    <div className="admin-error" role="alert">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}
