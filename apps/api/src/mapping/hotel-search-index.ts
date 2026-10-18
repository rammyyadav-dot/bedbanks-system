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

export interface HotelCandidateRow {
  hotelId: string
  vectorSimilarity: number
  nameSimilarity: number
  /** ts_rank_cd of the lexical match, 0 when the hotel only matched on another signal. */
  textRank: number
  /** Reciprocal Rank Fusion of the vector, trigram and lexical ranks. Orders candidates; never approves a mapping. */
  fusedScore: number
}

/** Candidates per retriever and the RRF constant (Lakebase hybrid-search defaults). */
const RETRIEVER_LIMIT = 40
const RRF_K = 60
const RESULT_LIMIT = 20

/**
 * Hybrid retrieval: vector, trigram and full-text candidates are fetched independently and fused by rank (RRF),
 * so incomparable raw scores are never mixed. Uses stock pgvector, pg_trgm and tsvector, available on any PostgreSQL.
 */
export async function retrieveHotelCandidates(tx: Prisma.TransactionClient, tenantId: string, observation: { name: string; address?: string | null; city?: string | null; countryCode?: string | null }, embedder: MappingEmbeddingProvider = embeddings): Promise<HotelCandidateRow[]> {
  const normalized = normalizeHotelIdentity(observation)
  const literal = vectorLiteral(embedder.embed(hotelEmbeddingText(normalized)))
  const text = [normalized.normalizedName, normalized.normalizedCity, normalized.normalizedAddress].join(' ')
  const country = normalized.normalizedCountryCode
  return tx.$queryRaw<HotelCandidateRow[]>`
    WITH q AS (
      SELECT replace(plainto_tsquery('simple', ${text})::text, ' & ', ' | ')::tsquery AS tsq
    ),
    -- Scope to the tenant first. As a plain WHERE the planner walks the HNSW index across all tenants and filters afterwards, so the
    -- vector arm can return fewer than RETRIEVER_LIMIT rows, or none (reproduced: 100 tenants, 0 of 20). docs/adr/0073.
    tenant_scope AS MATERIALIZED (
      SELECT "hotel_id", "embedding"
        FROM "HotelSearchIndex"
       WHERE "tenant_id" = ${tenantId} AND (${country} = '' OR "normalized_country_code" = ${country})
    ),
    vector_ranked AS (
      SELECT "hotel_id", "embedding" <=> ${literal}::vector AS distance,
             row_number() OVER (ORDER BY "embedding" <=> ${literal}::vector) AS rank
        FROM tenant_scope
       ORDER BY "embedding" <=> ${literal}::vector
       LIMIT ${RETRIEVER_LIMIT}
    ),
    trigram_ranked AS (
      SELECT "hotel_id", similarity("normalized_name", ${normalized.normalizedName}) AS sim,
             row_number() OVER (ORDER BY similarity("normalized_name", ${normalized.normalizedName}) DESC) AS rank
        FROM "HotelSearchIndex"
       WHERE "tenant_id" = ${tenantId} AND (${country} = '' OR "normalized_country_code" = ${country})
         AND "normalized_name" % ${normalized.normalizedName}
       ORDER BY sim DESC
       LIMIT ${RETRIEVER_LIMIT}
    ),
    text_ranked AS (
      SELECT "hotel_id", ts_rank_cd("search_tsv", q.tsq) AS score,
             row_number() OVER (ORDER BY ts_rank_cd("search_tsv", q.tsq) DESC) AS rank
        FROM "HotelSearchIndex", q
       WHERE "tenant_id" = ${tenantId} AND (${country} = '' OR "normalized_country_code" = ${country})
         AND "search_tsv" @@ q.tsq
       ORDER BY score DESC
       LIMIT ${RETRIEVER_LIMIT}
    ),
    fused AS (
      SELECT COALESCE(v."hotel_id", t."hotel_id", x."hotel_id") AS "hotel_id",
             COALESCE(1.0 / (${RRF_K} + v.rank), 0) + COALESCE(1.0 / (${RRF_K} + t.rank), 0) + COALESCE(1.0 / (${RRF_K} + x.rank), 0) AS fused
        FROM vector_ranked v
        FULL JOIN trigram_ranked t ON t."hotel_id" = v."hotel_id"
        FULL JOIN text_ranked x ON x."hotel_id" = COALESCE(v."hotel_id", t."hotel_id")
    )
    SELECT f."hotel_id" AS "hotelId",
           1 - (i."embedding" <=> ${literal}::vector) AS "vectorSimilarity",
           similarity(i."normalized_name", ${normalized.normalizedName}) AS "nameSimilarity",
           COALESCE(ts_rank_cd(i."search_tsv", q.tsq), 0)::float8 AS "textRank",
           f.fused::float8 AS "fusedScore"
      FROM fused f
      JOIN "HotelSearchIndex" i ON i."tenant_id" = ${tenantId} AND i."hotel_id" = f."hotel_id"
      CROSS JOIN q
     ORDER BY f.fused DESC, f."hotel_id" ASC
     LIMIT ${RESULT_LIMIT}
  `
}

export { EMBEDDING_MODEL }
