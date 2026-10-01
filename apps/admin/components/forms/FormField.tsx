import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

/** Labelled field. The label is programmatically associated with its input/select so assistive tech and tests can find it. */
export function FormField({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null;
  return (
    <div className="admin-login-field">
      <label htmlFor={only ? (only.props.id ?? id) : undefined}>{label}</label>
      {only ? cloneElement(only, { id: only.props.id ?? id }) : children}
    </div>
  );
}
