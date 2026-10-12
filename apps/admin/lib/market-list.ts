/** Comma-separated ISO-3166 alpha-2 codes as the plan and contract forms edit them. The API owns validation and the narrow-only rule. */
export const parseCodeList = (value: string): string[] => [...new Set(value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean))]
export const formatCodeList = (value: readonly string[] | null | undefined): string => (value ?? []).join(', ')
/** Codes that are not two letters, caught before a request; empty when the list is fine. */
export const badCodes = (codes: readonly string[]): string[] => codes.filter((code) => !/^[A-Z]{2}$/.test(code))
