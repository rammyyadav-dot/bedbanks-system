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
      ${literal}::vector, ${embedder.model}, CURRENT_TIMESTAMP
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

/**
 * Shortlists a tenant's hotels for a supplier observation by exact cosine distance over the tenant's own rows.
 *
 * The scope is a MATERIALIZED CTE on purpose. Left as a plain WHERE, the planner orders by the HNSW index and filters afterwards, so
 * with many tenants in one index the approximate scan returns other tenants' neighbours and the tenant gets fewer than LIMIT rows,
 * or none (reproduced: 100 tenants, 0 of 20 returned). Reading the tenant first makes recall exact and independent of pgvector's
 * version and of hnsw.ef_search. Cost grows with the tenant's own catalogue, not the cluster's (docs/adr/0073).
 */
export async function retrieveHotelCandidates(tx: Prisma.TransactionClient, tenantId: string, observation: { name: string; address?: string | null; city?: string | null; countryCode?: string | null }, embedder: MappingEmbeddingProvider = embeddings): Promise<Array<{ hotelId: string; vectorSimilarity: number; nameSimilarity: number }>> {
  const normalized = normalizeHotelIdentity(observation)
  const literal = vectorLiteral(embedder.embed(hotelEmbeddingText(normalized)))
  return tx.$queryRaw<Array<{ hotelId: string; vectorSimilarity: number; nameSimilarity: number }>>`
    WITH "scoped" AS MATERIALIZED (
      SELECT "hotel_id", "normalized_name", "embedding"
        FROM "HotelSearchIndex"
       WHERE "tenant_id" = ${tenantId}
         AND (${normalized.normalizedCountryCode} = '' OR "normalized_country_code" = ${normalized.normalizedCountryCode})
    )
    SELECT "hotel_id" AS "hotelId",
           (1 - ("embedding" <=> ${literal}::vector))::float8 AS "vectorSimilarity",
           similarity("normalized_name", ${normalized.normalizedName})::float8 AS "nameSimilarity"
      FROM "scoped"
     ORDER BY "embedding" <=> ${literal}::vector
     LIMIT 20
  `
}

export { EMBEDDING_MODEL }
