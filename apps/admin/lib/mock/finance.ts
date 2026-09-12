import type { Wallet, LedgerEntry, Payment } from '../types/admin';

export const wallets: Wallet[] = [
  { tenantId: 't_travel', tenant: 'Travel Republic', availableCredit: 84200, usedCredit: 15800, limit: 100000, currency: 'USD', status: 'active' },
  { tenantId: 't_atlas', tenant: 'Atlas Getaways', availableCredit: 12400, usedCredit: 7600, limit: 20000, currency: 'USD', status: 'active' },
  { tenantId: 't_holiday', tenant: 'Holiday Lines', availableCredit: 0, usedCredit: 45000, limit: 45000, currency: 'USD', status: 'suspended' },
  { tenantId: 't_global', tenant: 'Global Holidays', availableCredit: 61300, usedCredit: 18700, limit: 80000, currency: 'USD', status: 'active' },
];

export const ledger: LedgerEntry[] = [
  { id: 'lg_1', date: '2026-09-08', tenant: 'Travel Republic', reference: 'FB260908000124', type: 'Booking debit', debit: 1935.2, credit: 0, balance: 84200 },
  { id: 'lg_2', date: '2026-09-07', tenant: 'Travel Republic', reference: 'TOPUP-4471', type: 'Wallet top-up', debit: 0, credit: 20000, balance: 86135.2 },
  { id: 'lg_3', date: '2026-09-06', tenant: 'Enterprise Travel Group', reference: 'FB260906000071', type: 'Cancellation refund', debit: 0, credit: 356.5, balance: 24980 },
  { id: 'lg_4', date: '2026-09-05', tenant: 'Holiday Lines', reference: 'FB260905000032', type: 'Booking debit', debit: 2200, credit: 0, balance: 0 },
];

export const payments: Payment[] = [
  { id: 'py_1', reference: 'PAY-88213', tenant: 'Travel Republic', amount: 20000, currency: 'USD', method: 'Bank Transfer', status: 'success', date: '2026-09-07' },
  { id: 'py_2', reference: 'PAY-88214', tenant: 'Atlas Getaways', amount: 5000, currency: 'USD', method: 'Card', status: 'pending', date: '2026-09-08' },
  { id: 'py_3', reference: 'PAY-88190', tenant: 'Global Holidays', amount: 15000, currency: 'USD', method: 'Bank Transfer', status: 'failed', date: '2026-09-03' },
];
