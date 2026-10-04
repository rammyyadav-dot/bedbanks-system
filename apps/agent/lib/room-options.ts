/** A room group is selectable when it has at least one instantly sellable rate: neither sold out nor on request. */
export function selectableRoomCount(rooms: Array<{ rates: Array<{ availability: string }> }>): number {
  return rooms.filter((room) => room.rates.some((rate) => rate.availability !== 'sold_out' && rate.availability !== 'on_request')).length
}

export function selectableRoomLabel(count: number): string {
  return `${count} ${count === 1 ? 'room option' : 'room options'}`
}
