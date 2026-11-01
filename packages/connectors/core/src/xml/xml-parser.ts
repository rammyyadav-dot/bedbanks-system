/**
 * Strict, dependency-free XML reader/writer for supplier XML connectors.
 *
 * Supplier XML is untrusted input. This parser is deliberately smaller than the XML spec:
 *  - any DOCTYPE / ENTITY declaration is refused (no XXE, no entity-expansion bombs);
 *  - only the five predefined entities and numeric character references are decoded;
 *  - processing instructions other than the leading XML declaration are refused;
 *  - size, depth, node and attribute budgets are enforced before memory is spent;
 *  - namespace prefixes are dropped (`soap:Fault` -> `Fault`) so profiles match on local names.
 * Errors carry a code only, never a fragment of the document (it may contain guest data or credentials).
 */
export type XmlParseErrorCode = 'too_large' | 'too_deep' | 'too_many_nodes' | 'forbidden_construct' | 'malformed' | 'empty'
export class XmlParseError extends Error {
  constructor(readonly code: XmlParseErrorCode) { super(`XML rejected (${code})`); this.name = 'XmlParseError' }
}

export interface XmlNode {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: readonly XmlNode[]
  /** Concatenated character data directly inside this element, trimmed. */
  readonly text: string
}

export interface XmlLimits { maxBytes: number; maxDepth: number; maxNodes: number; maxAttributes: number }
export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxDepth: 48, maxNodes: 250_000, maxAttributes: 64 })

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_.:-]/
const ENTITY = /&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeText(raw: string): string {
  if (!raw.includes('&')) return raw
  // Any ampersand that is not a predefined or numeric reference is an undeclared entity.
  if (raw.replace(ENTITY, '').includes('&')) throw new XmlParseError('malformed')
  return raw.replace(ENTITY, (_m, ref: string) => {
    if (ref[0] !== '#') return NAMED[ref]
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    const legal = code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
    if (!legal) throw new XmlParseError('malformed')
    return String.fromCodePoint(code)
  })
}

export function parseXml(input: string | Uint8Array, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlNode {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength
  if (bytes > limits.maxBytes) throw new XmlParseError('too_large')
  let text: string
  try { text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input) } catch { throw new XmlParseError('malformed') }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let i = 0
  let nodes = 0
  const n = text.length
  const stack: Array<{ name: string; attrs: Record<string, string>; children: XmlNode[]; text: string[] }> = []
  let root: XmlNode | null = null

  const skipSpace = (): void => { while (i < n && /\s/.test(text[i])) i++ }
  const readName = (): string => {
    const start = i
    if (i >= n || !NAME_START.test(text[i])) throw new XmlParseError('malformed')
    while (i < n && NAME_CHAR.test(text[i])) i++
    return text.slice(start, i)
  }
  const local = (qualified: string): string => qualified.slice(qualified.indexOf(':') + 1)

  // The XML declaration is only legal at the very start.
  if (text.startsWith('<?xml') && /^<\?xml[\s?]/.test(text)) {
    const end = text.indexOf('?>')
    if (end < 0) throw new XmlParseError('malformed')
    i = end + 2
  }

  while (i < n) {
    const lt = text.indexOf('<', i)
    const chunk = text.slice(i, lt < 0 ? n : lt)
    if (chunk.length) {
      if (stack.length) stack[stack.length - 1].text.push(decodeText(chunk))
      else if (chunk.trim()) throw new XmlParseError('malformed')
    }
    if (lt < 0) break
    i = lt
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end < 0) throw new XmlParseError('malformed')
      i = end + 3
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9)
      if (end < 0 || !stack.length) throw new XmlParseError('malformed')
      stack[stack.length - 1].text.push(text.slice(i + 9, end))
      i = end + 3
    } else if (text.startsWith('<!', i)) {
      throw new XmlParseError('forbidden_construct')
    } else if (text.startsWith('<?', i)) {
      throw new XmlParseError('forbidden_construct')
    } else if (text.startsWith('</', i)) {
      i += 2
      const name = readName()
      skipSpace()
      if (text[i] !== '>') throw new XmlParseError('malformed')
      i++
      const open = stack.pop()
      if (!open || open.name !== name) throw new XmlParseError('malformed')
      const node: XmlNode = { name: local(open.name), attrs: open.attrs, children: open.children, text: open.text.join('').trim() }
      if (stack.length) stack[stack.length - 1].children.push(node)
      else if (root) throw new XmlParseError('malformed')
      else root = node
    } else {
      i++
      const name = readName()
      const attrs: Record<string, string> = {}
      let count = 0
      let selfClosing = false
      for (;;) {
        skipSpace()
        if (i >= n) throw new XmlParseError('malformed')
        if (text[i] === '>') { i++; break }
        if (text[i] === '/' && text[i + 1] === '>') { i += 2; selfClosing = true; break }
        const attr = readName()
        skipSpace()
        if (text[i] !== '=') throw new XmlParseError('malformed')
        i++
        skipSpace()
        const quote = text[i]
        if (quote !== '"' && quote !== "'") throw new XmlParseError('malformed')
        const end = text.indexOf(quote, i + 1)
        if (end < 0) throw new XmlParseError('malformed')
        const value = text.slice(i + 1, end)
        if (value.includes('<')) throw new XmlParseError('malformed')
        if (++count > limits.maxAttributes) throw new XmlParseError('too_many_nodes')
        const key = local(attr)
        if (key in attrs) throw new XmlParseError('malformed')
        // xmlns declarations are namespace plumbing, not data.
        if (attr !== 'xmlns' && !attr.startsWith('xmlns:')) attrs[key] = decodeText(value)
        i = end + 1
      }
      if (++nodes > limits.maxNodes) throw new XmlParseError('too_many_nodes')
      if (stack.length + 1 > limits.maxDepth) throw new XmlParseError('too_deep')
      if (selfClosing) {
        const node: XmlNode = { name: local(name), attrs, children: [], text: '' }
        if (stack.length) stack[stack.length - 1].children.push(node)
        else if (root) throw new XmlParseError('malformed')
        else root = node
      } else stack.push({ name, attrs, children: [], text: [] })
    }
  }
  if (stack.length) throw new XmlParseError('malformed')
  if (!root) throw new XmlParseError('empty')
  return root
}

/** Direct children with a local name. */
export function kids(node: XmlNode, name: string): XmlNode[] { return node.children.filter((c) => c.name === name) }
export function kid(node: XmlNode, name: string): XmlNode | undefined { return node.children.find((c) => c.name === name) }
/** Walk a path of local names, returning the first match at each step. */
export function at(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let current = node
  for (const step of path) { if (!current) return undefined; current = kid(current, step) }
  return current
}
/** Required text; a missing or empty value is a malformed supplier response, never a default. */
export function requiredText(node: XmlNode | undefined, ...path: string[]): string {
  const found = at(node, ...path)
  if (!found || !found.text) throw new XmlParseError('malformed')
  return found.text
}
export function requiredAttr(node: XmlNode, name: string): string {
  const value = node.attrs[name]
  if (value === undefined || value === '') throw new XmlParseError('malformed')
  return value
}

const ELEMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g

export function xmlEscape(value: string): string {
  return value.replace(FORBIDDEN_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Builds an element. Names are validated and every value is escaped, so caller data can never inject markup into a supplier request.
 * Children may be strings (escaped text), already-built elements (`XmlRaw`), or nullish (skipped).
 */
export class XmlRaw { constructor(readonly xml: string) {} }
export function el(name: string, attrs: Record<string, string | number | undefined> | null, ...content: Array<string | number | XmlRaw | null | undefined | false>): XmlRaw {
  if (!ELEMENT_NAME.test(name)) throw new XmlParseError('malformed')
  let open = `<${name}`
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined) continue
    if (!ELEMENT_NAME.test(key)) throw new XmlParseError('malformed')
    open += ` ${key}="${xmlEscape(String(value))}"`
  }
  const body = content.map((c) => (c === null || c === undefined || c === false ? '' : c instanceof XmlRaw ? c.xml : xmlEscape(String(c)))).join('')
  return new XmlRaw(body ? `${open}>${body}</${name}>` : `${open}/>`)
}
export function xmlDocument(root: XmlRaw): string { return `<?xml version="1.0" encoding="UTF-8"?>${root.xml}` }
