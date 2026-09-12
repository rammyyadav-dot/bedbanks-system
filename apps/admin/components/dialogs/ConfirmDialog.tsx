'use client';

export function ConfirmDialog({
  open, onCancel, onConfirm, title, description, confirmLabel = 'Confirm', danger,
}: { open: boolean; onCancel: () => void; onConfirm: () => void; title: string; description: string; confirmLabel?: string; danger?: boolean }) {
  if (!open) return null;
  return (
    <div className="admin-modal-backdrop" onClick={onCancel}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <p>{description}</p>
        <div className="admin-modal-actions">
          <button type="button" className="admin-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className={`admin-btn ${danger ? 'admin-btn-danger' : 'admin-btn-primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
