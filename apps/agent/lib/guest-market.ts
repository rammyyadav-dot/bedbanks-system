import { GUEST_MARKETS, isGuestMarket as marketCode } from './guest-markets.mjs'

export { GUEST_MARKETS }

export function isGuestMarket(value: unknown): value is string {
  return marketCode(value)
}

export function guestMarketName(code: string): string {
  return GUEST_MARKETS.find((market) => market.code === code)?.name ?? code
}

export function guestNationalityKey(userId: string) {
  return `fbeds.agent.guest-nationality.${userId}`
}

export function readGuestNationality(storage: Pick<Storage, 'getItem'>, userId: string): string | null {
  if (!userId) return null
  const value = storage.getItem(guestNationalityKey(userId))
  return isGuestMarket(value) ? value : null
}

export function rememberGuestNationality(storage: Pick<Storage, 'setItem'>, userId: string, code: string) {
  if (!userId || !isGuestMarket(code)) return
  storage.setItem(guestNationalityKey(userId), code)
}

export function clearGuestNationality(storage: Pick<Storage, 'removeItem'>, userId: string) {
  if (userId) storage.removeItem(guestNationalityKey(userId))
}
