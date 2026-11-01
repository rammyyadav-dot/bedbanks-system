import test from 'node:test'
import assert from 'node:assert/strict'
import { parseXml, el, xmlDocument, at, requiredText, kids, XmlParseError } from '../src/xml/xml-parser.ts'

const code = (c) => (e) => e instanceof XmlParseError && e.code === c && !/secret|<|>/.test(e.message)

test('parses nested elements, attributes, namespaces, CDATA and entities', () => {
  const root = parseXml(`<?xml version="1.0"?><soap:Envelope xmlns:soap="urn:x"><soap:Body><r id="7" a:b="1" xmlns:a="u"><n>A &amp; B &#x41;&#66;</n><c><![CDATA[<raw>]]></c><e/></r></soap:Body></soap:Envelope>`)
  assert.equal(root.name, 'Envelope')
  const r = at(root, 'Body', 'r')
  assert.equal(r.attrs.id, '7'); assert.equal(r.attrs.b, '1'); assert.equal('xmlns' in r.attrs, false)
  assert.equal(requiredText(r, 'n'), 'A & B AB'); assert.equal(requiredText(r, 'c'), '<raw>')
  assert.equal(kids(r, 'e').length, 1)
})
test('refuses DOCTYPE, ENTITY and processing instructions (XXE / billion laughs)', () => {
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'), code('forbidden_construct'))
  assert.throws(() => parseXml('<a><?php echo 1 ?></a>'), code('forbidden_construct'))
  assert.throws(() => parseXml('<a>&lol9;</a>'), code('malformed'))
  assert.throws(() => parseXml('<a>bare & ampersand</a>'), code('malformed'))
  assert.throws(() => parseXml('<a>&#0;</a>'), code('malformed'))
})
test('refuses malformed structure', () => {
  for (const bad of ['<a><b></a></b>', '<a>', '<a></a><b/>', 'text', '', '<a b=1/>', '<a b="1" b="2"/>', '<a b="<"/>', '<a>x</a>trailing']) assert.throws(() => parseXml(bad), XmlParseError, bad)
})
test('enforces size, depth and node budgets', () => {
  assert.throws(() => parseXml('<a>' + 'x'.repeat(100) + '</a>', { maxBytes: 50, maxDepth: 5, maxNodes: 5, maxAttributes: 5 }), code('too_large'))
  assert.throws(() => parseXml('<a><a><a><a/></a></a></a>', { maxBytes: 1000, maxDepth: 3, maxNodes: 100, maxAttributes: 5 }), code('too_deep'))
  assert.throws(() => parseXml('<a>' + '<b/>'.repeat(10) + '</a>', { maxBytes: 1000, maxDepth: 5, maxNodes: 5, maxAttributes: 5 }), code('too_many_nodes'))
  assert.throws(() => parseXml(Buffer.from([0x3c, 0x61, 0xff, 0x3e])), code('malformed'))
})
test('required accessors never default', () => {
  const root = parseXml('<a><b></b></a>')
  assert.throws(() => requiredText(root, 'b'), XmlParseError)
  assert.throws(() => requiredText(root, 'missing'), XmlParseError)
})
test('builder escapes values and validates names so caller data cannot inject markup', () => {
  const evil = `</guest><admin x="1">'"&\u0000`
  const xml = xmlDocument(el('req', { ref: evil }, el('guest', null, evil)))
  const back = parseXml(xml)
  assert.equal(back.attrs.ref, `</guest><admin x="1">'"&`)
  assert.equal(at(back, 'guest').text, `</guest><admin x="1">'"&`)
  assert.equal(kids(back, 'admin').length, 0)
  assert.throws(() => el('a b', null), XmlParseError)
  assert.throws(() => el('a', { 'x"y': '1' }), XmlParseError)
})
