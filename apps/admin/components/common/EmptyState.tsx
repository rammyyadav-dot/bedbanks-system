export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="admin-empty">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}
