import type { BookingCancellationService, CancellationCommand } from '../../src/agent/booking-cancellation.service'

export async function acceptCancellation(service: BookingCancellationService, command: CancellationCommand) {
  const quoteId = command.quoteId ?? (await service.quote(command)).quoteId
  return service.cancel({ ...command, quoteId })
}
