'use client';

import { usePathname } from 'next/navigation';
import { flatNav } from './nav-config';

export function Breadcrumbs() {
  const pathname = usePathname() ?? '/dashboard';
  const match = flatNav.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  const segments = pathname.split('/').filter(Boolean);
  const detail = segments.length > 1 ? segments[segments.length - 1] : null;
  const isDetailId = detail && !['new', 'roles', 'permissions', 'wallets', 'ledger', 'payments'].includes(detail);

  return (
    <div className="breadcrumb">
      <span>FBEDS Admin</span>
      <b>/</b>
      <strong>{match?.label ?? 'Dashboard'}</strong>
      {isDetailId && (
        <>
          <b>/</b>
          <strong>{detail}</strong>
        </>
      )}
    </div>
  );
}
