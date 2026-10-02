/** A room group is commercially usable when it has at least one rate that is not sold out. */
export function selectableRoomCount(rooms: Array<{ rates: Array<{ availability: string }> }>): number {
  return rooms.filter((room) => room.rates.some((rate) => rate.availability !== 'sold_out')).length
}

export function selectableRoomLabel(count: number): string {
  return `${count} ${count === 1 ? 'room option' : 'room options'}`
}
