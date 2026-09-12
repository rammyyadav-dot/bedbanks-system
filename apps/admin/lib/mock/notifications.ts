import type { EmailLog } from '../types/admin';

export const emailLogs: EmailLog[] = [
  { id: 'em_1', messageId: 'msg_7a21', event: 'booking.confirmed', recipient: 'maya@travelrepublic.example', subject: 'Booking confirmed — FB260908000124', status: 'delivered', sentAt: '2026-09-08T10:23:00Z', provider: 'SES' },
  { id: 'em_2', messageId: 'msg_7a22', event: 'wallet.low_balance', recipient: 'finance@holidaylines.example', subject: 'Wallet balance below threshold', status: 'bounced', sentAt: '2026-09-08T09:00:00Z', provider: 'SES' },
  { id: 'em_3', messageId: 'msg_7a23', event: 'booking.cancelled', recipient: 'amara@enterprisetravel.example', subject: 'Booking cancelled — FB260906000071', status: 'delivered', sentAt: '2026-09-06T09:14:00Z', provider: 'SES' },
  { id: 'em_4', messageId: 'msg_7a24', event: 'user.invited', recipient: 'leo@sunrisetours.example', subject: 'You have been invited to FBEDS', status: 'pending', sentAt: '2026-09-09T08:05:00Z', provider: 'SES' },
];
