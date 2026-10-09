export interface CalendarEdit {
  rates?: Array<{ ratePlanId: string; stayDate: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string; expectedUpdatedAt: string | null }>
  availability?: Array<{ ratePlanId: string; stayDate: string; allotment: number; stopSell: boolean; minStay: number; expectedUpdatedAt: string | null }>
}
export interface CalendarPreview {
  atomic: boolean; affectedCells: number;
  changes: Array<{ kind: string; ratePlanId: string; stayDate: string; before: Record<string, unknown> | null; after: Record<string, unknown> }>
}
