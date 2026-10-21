import { XmlParseError, parseXml, type XmlNode } from '../xml/xml-parser'

/** A flat, string-valued view of one supplier record. Canonical validation happens later, once, for every provider. */
export type RawRecord = Readonly<Record<string, string | undefined>>

export interface FieldSource {
  /**
   * XML: `Child/Sub`, `@attr`, `Child/@attr` or `.` (own text). JSON: dotted path from the addressed level.
   */
  path: string
  /** Index into the ancestor chain of the record path (0 = first iterated level). Defaults to the record level. */
  level?: number
}
export type FieldMap = Readonly<Record<string, FieldSource>>

export interface ExtractionSpec {
  /** XML: element names from the root's children, e.g. `['Hotel','Room','Rate']`. JSON: `data.hotels[].rooms[].rates[]`. */
  recordPath: string | readonly string[]
  fields: FieldMap
}

export class IngestShapeError extends Error {
  constructor() { super('Ingest document shape rejected'); this.name = 'IngestShapeError' }
}

const MAX_RECORDS = 500_000

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  if (typeof value === 'number') {
    // A JSON number has already lost its original text. Accept only values whose shortest form is a plain decimal.
    const text = String(value)
    return Number.isFinite(value) && /^-?\d+(\.\d+)?$/.test(text) ? text : undefined
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return undefined
}

function xmlField(node: XmlNode | undefined, path: string): string | undefined {
  if (!node) return undefined
  if (path === '.') return node.text === '' ? undefined : node.text
  const parts = path.split('/')
  let current: XmlNode | undefined = node
  for (let i = 0; i < parts.length && current; i++) {
    const part = parts[i]
    if (part.startsWith('@')) {
      if (i !== parts.length - 1) return undefined
      const v = current.attrs[part.slice(1)]
      return v === undefined || v.trim() === '' ? undefined : v.trim()
    }
    current = current.children.find((c) => c.name === part)
  }
  return current && current.text !== '' ? current.text : undefined
}

export function extractXmlRecords(input: string | Uint8Array, spec: ExtractionSpec): RawRecord[] {
  const steps = Array.isArray(spec.recordPath) ? spec.recordPath : [spec.recordPath as string]
  if (steps.length === 0) throw new IngestShapeError()
  let root: XmlNode
  try { root = parseXml(input) } catch (e) { if (e instanceof XmlParseError) throw new IngestShapeError(); throw e }
  let chains: XmlNode[][] = [[root]]
  for (const step of steps) {
    const next: XmlNode[][] = []
    for (const chain of chains) for (const child of chain[chain.length - 1].children) if (child.name === step) next.push([...chain, child])
    chains = next
    if (chains.length > MAX_RECORDS) throw new IngestShapeError()
  }
  return chains.map((chain) => {
    const out: Record<string, string | undefined> = {}
    for (const [name, source] of Object.entries(spec.fields)) out[name] = xmlField(chain[(source.level ?? steps.length - 1) + 1], source.path)
    return out
  })
}

function jsonField(value: unknown, path: string): string | undefined {
  let current: unknown = value
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined
    current = Object.prototype.hasOwnProperty.call(current, part) ? (current as Record<string, unknown>)[part] : undefined
  }
  return asText(current)
}

export function extractJsonRecords(input: string | unknown, spec: ExtractionSpec): RawRecord[] {
  let doc: unknown = input
  if (typeof input === 'string') { try { doc = JSON.parse(input) } catch { throw new IngestShapeError() } }
  const path = Array.isArray(spec.recordPath) ? spec.recordPath.join('.') : (spec.recordPath as string)
  const segments = path.split('.').filter(Boolean)
  if (segments.length === 0) throw new IngestShapeError()
  let chains: unknown[][] = [[doc]]
  for (const segment of segments) {
    const iterate = segment.endsWith('[]')
    const key = iterate ? segment.slice(0, -2) : segment
    const next: unknown[][] = []
    for (const chain of chains) {
      const last = chain[chain.length - 1]
      if (last === null || typeof last !== 'object' || Array.isArray(last) || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new IngestShapeError()
      const value = Object.prototype.hasOwnProperty.call(last, key) ? (last as Record<string, unknown>)[key] : undefined
      if (iterate) {
        if (!Array.isArray(value)) throw new IngestShapeError()
        for (const item of value) next.push([...chain, item])
      } else {
        if (value === undefined) throw new IngestShapeError()
        next.push([...chain, value])
      }
    }
    chains = next
    if (chains.length > MAX_RECORDS) throw new IngestShapeError()
  }
  // Levels count only iterated segments; non-iterated steps share their parent's level.
  const levelIndex: number[] = []
  segments.forEach((s, i) => { if (s.endsWith('[]')) levelIndex.push(i + 1) })
  const recordLevel = levelIndex.length - 1
  return chains.map((chain) => {
    const out: Record<string, string | undefined> = {}
    for (const [name, source] of Object.entries(spec.fields)) {
      const idx = levelIndex[source.level ?? recordLevel]
      out[name] = idx === undefined ? undefined : jsonField(chain[idx], source.path)
    }
    return out
  })
}
