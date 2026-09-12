import type { SupplierSearchResult } from '../types/admin';

export const searchComparison: SupplierSearchResult[] = [
  { supplier: 'Supplier One', responseMs: 820, results: 84, mapped: 79, deduplicated: 61, priced: 61, status: 'ok' },
  { supplier: 'Supplier Two', responseMs: 1240, results: 62, mapped: 58, deduplicated: 44, priced: 42, status: 'slow' },
  { supplier: 'Global Hotel Supply', responseMs: 540, results: 103, mapped: 97, deduplicated: 80, priced: 78, status: 'ok' },
  { supplier: 'Regional DMC', responseMs: 3100, results: 0, mapped: 0, deduplicated: 0, priced: 0, status: 'error' },
];
