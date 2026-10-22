import type { Prisma } from '@prisma/client'

/** Hotel coordinates as trimmed decimal strings (six places). Not for money: money is integer minor units. */
export const formatCoordinate = (d: Prisma.Decimal | null): string | null => (d === null ? null : d.toFixed(6).replace(/\.?0+$/, '') || '0')
