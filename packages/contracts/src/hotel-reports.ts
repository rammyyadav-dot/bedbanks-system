/** Hotel-scoped booking cohort report. Money is exact integer minor units, kept per original currency. */
export interface HotelReportQuery { from: string; to: string; dateBasis: 'booking' | 'stay'; supplier?: string }
export interface HotelReportCurrency {
  currency: string; reportingCurrency: string; conversionBasis: 'IDENTITY'; bookings: number
  grossMinor: string; netMinor: string | null; marginMinor: string | null
  cancelledGrossMinor: string; refundMinor: string | null; penaltyMinor: string | null; taxesMinor: null
}
export interface HotelReportView {
  hotelId: string; generatedAt: string; query: HotelReportQuery; totalReservations: number
  roomNights: number; unknownRoomNightReservations: number; cancelledReservations: number
  currencies: HotelReportCurrency[]; nationality: Array<{ nationality: string; guests: number }>
  definitions: Record<string, string>; limitations: string[]
}
