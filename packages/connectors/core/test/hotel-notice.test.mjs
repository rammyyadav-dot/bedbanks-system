import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOtaHotelResNotif, hotelNoticeEchoToken, HotelNoticeInvalid } from '../src/hotel-notice/ota-res-notif.ts'
import { parseXml } from '../src/xml/xml-parser.ts'

const notice = (extra = {}) => ({
  kind: 'NEW', reference: 'FB-0123456789ABCDEF0123', hotelCode: 'DXB-ATL-01', createdAt: '2026-10-30T08:00:00.000Z', checkIn: '2026-12-01', checkOut: '2026-12-04',
  roomName: 'Deluxe King', boardCode: 'BB', rooms: [{ adults: 2, childAges: [7] }, { adults: 1, childAges: [] }],
  guests: [{ firstName: 'Amal', lastName: 'Haddad', isLead: true }, { firstName: 'Sam', lastName: 'Haddad', isLead: false }], hotelConfirmationNo: null, specialRequests: ['High floor'], arrivalTime: '15:30', ...extra,
})

test('builds well-formed OTA XML with one RoomStay per room, the lead guest marked primary, and no price anywhere', () => {
  const xml = buildOtaHotelResNotif(notice())
  parseXml(xml) // throws if malformed
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><OTA_HotelResNotifRQ /)
  assert.match(xml, /ResStatus="Commit"/)
  assert.equal((xml.match(/<RoomStay /g) ?? []).length, 2)
  assert.match(xml, /<GuestCount AgeQualifyingCode="8" Count="1" Age="7"\/>/)
  assert.match(xml, /PrimaryIndicator="true"/)
  assert.match(xml, /<TimeSpan Start="2026-12-01" End="2026-12-04"\/>/)
  assert.doesNotMatch(xml, /Total|Amount|Rate=|Currency|Net|Markup/i)
})

test('status and echo token follow the kind, and a retry has the same token', () => {
  assert.match(buildOtaHotelResNotif(notice({ kind: 'CANCEL' })), /ResStatus="Cancel"/)
  assert.match(buildOtaHotelResNotif(notice({ kind: 'AMEND', hotelConfirmationNo: 'H-77' })), /ResStatus="Modify"[\s\S]*ResID_Value="H-77"/)
  assert.equal(hotelNoticeEchoToken(notice()), hotelNoticeEchoToken(notice({ createdAt: '2026-10-30T09:00:00.000Z' })))
  assert.notEqual(hotelNoticeEchoToken(notice()), hotelNoticeEchoToken(notice({ kind: 'CANCEL' })))
})

test('guest text cannot inject markup', () => {
  const xml = buildOtaHotelResNotif(notice({ guests: [{ firstName: '</GivenName><Evil/>', lastName: `O'Neil & "Sons"`, isLead: true }], specialRequests: ['<script>x</script>'] }))
  parseXml(xml)
  assert.doesNotMatch(xml, /<Evil|<script/)
  assert.match(xml, /O&apos;Neil &amp; &quot;Sons&quot;/)
})

test('fails closed on anything that cannot be validated', () => {
  for (const bad of [{ checkOut: '2026-12-01' }, { rooms: [] }, { rooms: [{ adults: 0, childAges: [] }] }, { rooms: [{ adults: 1, childAges: [18] }] }, { guests: [] }, { guests: [{ firstName: ' ', lastName: 'X', isLead: true }] }, { reference: 'bad ref' }, { hotelCode: '' }, { arrivalTime: '25:00' }, { createdAt: 'yesterday' }, { kind: 'DELETE' }]) {
    assert.throws(() => buildOtaHotelResNotif(notice(bad)), HotelNoticeInvalid, JSON.stringify(bad))
  }
})
