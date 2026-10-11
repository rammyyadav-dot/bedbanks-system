'use client';

import { usePathname } from 'next/navigation';
import { breadcrumbTrail } from './nav-config';

export function Breadcrumbs() {
  const { label, detail } = breadcrumbTrail(usePathname());

  return (
    <div className="breadcrumb">
      <span>FBEDS Admin</span>
      <b>/</b>
      <strong>{label}</strong>
      {detail && (
        <>
          <b>/</b>
          <strong>{detail}</strong>
        </>
      )}
    </div>
  );
}
