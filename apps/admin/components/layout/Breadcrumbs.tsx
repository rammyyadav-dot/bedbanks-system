'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { breadcrumbItems } from '@/lib/shell-navigation';

export function Breadcrumbs() {
  const items = breadcrumbItems(usePathname());

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol>
        {items.map((item, index) => (
          <li key={`${index}-${item.label}`}>
            {index > 0 && <b aria-hidden="true">/</b>}
            {item.href && !item.current
              ? <Link href={item.href}>{item.label}</Link>
              : <strong aria-current={item.current ? 'page' : undefined}>{item.label}</strong>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
