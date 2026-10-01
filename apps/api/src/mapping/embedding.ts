import { createHash } from 'crypto'

export const EMBEDDING_DIMENSION = 64
export const EMBEDDING_MODEL = 'fbeds-token-hash-v1'

export interface MappingEmbeddingProvider {
  readonly model: string
  readonly dimension: number
  embed(text: string): number[]
}

/** Local hashed-token embedding. No network call and no supplier payload is stored. */
export class HashedTokenEmbeddingProvider implements MappingEmbeddingProvider {
  readonly model = EMBEDDING_MODEL
  readonly dimension = EMBEDDING_DIMENSION

  embed(text: string): number[] {
    const vector = Array.from({ length: EMBEDDING_DIMENSION }, () => 0)
    const parts = text.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1)
    for (const token of parts) {
      const digest = createHash('sha256').update(token).digest()
      const index = digest[0] % EMBEDDING_DIMENSION
      const sign = digest[1] % 2 === 0 ? 1 : -1
      vector[index] += sign
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    if (norm === 0) return vector
    return vector.map((value) => value / norm)
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export function hotelEmbeddingText(input: { normalizedName: string; normalizedAddress: string; normalizedCity: string; normalizedCountryCode: string }): string {
  return [input.normalizedName, input.normalizedCity, input.normalizedCountryCode, input.normalizedAddress].filter(Boolean).join(' ')
}
