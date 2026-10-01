import { Prisma } from '@prisma/client'
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL, hotelEmbeddingText, type MappingEmbeddingProvider, HashedTokenEmbeddingProvider } from './embedding'
import { normalizeHotelIdentity } from './normalize'

const embeddings = new HashedTokenEmbeddingProvider()

export interface HotelIndexRow {
  hotelId: string
  name: string
  address?: string | null
  city: string
  countryCode: string
  postalCode?: string | null
  latitude?: number | null
  longitude?: number | null
  brand?: string | null
}

function vectorLiteral(values: number[]): string {
  if (values.length !== EMBEDDING_DIMENSION || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding dimension is invalid')
  }
  return `[${values.map((value) => value.toFixed(8)).join(',')}]`
}

export async function upsertHotelSearchIndex(tx: Prisma.TransactionClient, tenantId: string, hotel: HotelIndexRow, embedder: MappingEmbeddingProvider = embeddings): Promise<void> {
  const normalized = normalizeHotelIdentity(hotel)
  if (!normalized.normalizedCountryCode) throw new Error('A normalized country code is required')
  const embedding = embedder.embed(hotelEmbeddingText(normalized))
  const literal = vectorLiteral(embedding)
  await tx.$executeRaw`
    INSERT INTO "HotelSearchIndex" (
      "id", "tenant_id", "hotel_id", "normalized_name", "normalized_address", "normalized_city",
      "normalized_country_code", "latitude", "longitude", "embedding", "embedding_model", "updated_at"
    ) VALUES (
      ${`hsi_${hotel.hotelId}`}, ${tenantId}, ${hotel.hotelId}, ${normalized.normalizedName}, ${normalized.normalizedAddress},
      ${normalized.normalizedCity}, ${normalized.normalizedCountryCode}, ${hotel.latitude ?? null}, ${hotel.longitude ?? null},
      ${Prisma.raw(`'${literal}'::vector`)}, ${embedder.model}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenant_id", "hotel_id") DO UPDATE SET
      "normalized_name" = EXCLUDED."normalized_name",
      "normalized_address" = EXCLUDED."normalized_address",
      "normalized_city" = EXCLUDED."normalized_city",
      "normalized_country_code" = EXCLUDED."normalized_country_code",
      "latitude" = EXCLUDED."latitude",
      "longitude" = EXCLUDED."longitude",
      "embedding" = EXCLUDED."embedding",
      "embedding_model" = EXCLUDED."embedding_model",
      "updated_at" = CURRENT_TIMESTAMP
  `
}

export async function retrieveHotelCandidates(tx: Prisma.TransactionClient, tenantId: string, observation: { name: string; address?: string | null; city?: string | null; countryCode?: string | null }, embedder: MappingEmbeddingProvider = embeddings): Promise<Array<{ hotelId: string; vectorSimilarity: number; nameSimilarity: number }>> {
  const normalized = normalizeHotelIdentity(observation)
  const literal = vectorLiteral(embedder.embed(hotelEmbeddingText(normalized)))
  return tx.$queryRaw<Array<{ hotelId: string; vectorSimilarity: number; nameSimilarity: number }>>`
    SELECT "hotel_id" AS "hotelId",
           1 - ("embedding" <=> ${Prisma.raw(`'${literal}'::vector`)}) AS "vectorSimilarity",
           similarity("normalized_name", ${normalized.normalizedName}) AS "nameSimilarity"
      FROM "HotelSearchIndex"
     WHERE "tenant_id" = ${tenantId}
       AND (${normalized.normalizedCountryCode} = '' OR "normalized_country_code" = ${normalized.normalizedCountryCode})
     ORDER BY "embedding" <=> ${Prisma.raw(`'${literal}'::vector`)}
     LIMIT 20
  `
}

export { EMBEDDING_MODEL }
