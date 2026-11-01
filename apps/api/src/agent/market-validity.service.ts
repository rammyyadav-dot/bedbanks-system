import { Injectable } from '@nestjs/common'
import type { PrismaService } from '../database/prisma.service'

export interface MarketValidityRuleGroupInput {
  id?: string
  code?: string
  name?: string
  countryCodes: string[]
  isActive?: boolean
}

export interface MarketValidityRuleInput {
  id: string
  ratePlanId?: string | null
  inclusionType: 'INCLUDE' | 'EXCLUDE' | string
  matchType: 'COUNTRY_CODE' | 'MARKET_GROUP' | 'WORLDWIDE' | string
  countryCodes: string[]
  marketGroupId?: string | null
  marketGroup?: MarketValidityRuleGroupInput | null
}

/**
 * Pure deterministic evaluation of a source market country code against a rate plan's explicit rules
 * or fallback contract-level rules (ADR 0107).
 *
 * Precedence:
 * 1. Explicit Rate Plan rules override Contract-level rules.
 * 2. EXCLUDE rules take absolute precedence over INCLUDE rules (fail-safe restriction).
 * 3. If no market validity rule is attached, default to open worldwide (`worldwide_default`).
 */
export function evaluateMarketRules(
  ratePlanRules: readonly MarketValidityRuleInput[],
  contractRules: readonly MarketValidityRuleInput[],
  sourceMarketCountryCode: string
): { isValid: boolean; matchedRuleId: string | null; reason: string } {
  const rules = ratePlanRules.length > 0 ? ratePlanRules : contractRules

  if (rules.length === 0) {
    return { isValid: true, matchedRuleId: null, reason: 'worldwide_default' }
  }

  let isIncluded = false
  let matchedRuleId: string | null = null
  const normalizedCountry = (sourceMarketCountryCode ?? '').trim().toUpperCase()

  for (const rule of rules) {
    let matches = false

    if (rule.matchType === 'WORLDWIDE') {
      matches = true
    } else if (rule.matchType === 'COUNTRY_CODE') {
      matches = rule.countryCodes.map((c) => c.toUpperCase()).includes(normalizedCountry)
    } else if (rule.matchType === 'MARKET_GROUP' && rule.marketGroup && rule.marketGroup.isActive !== false) {
      matches = rule.marketGroup.countryCodes.map((c) => c.toUpperCase()).includes(normalizedCountry)
    }

    if (matches) {
      if (rule.inclusionType === 'EXCLUDE') {
        return { isValid: false, matchedRuleId: rule.id, reason: 'explicitly_excluded_by_source_market' }
      }
      if (rule.inclusionType === 'INCLUDE') {
        isIncluded = true
        matchedRuleId = rule.id
      }
    }
  }

  return {
    isValid: isIncluded,
    matchedRuleId,
    reason: isIncluded ? 'valid_source_market_match' : 'source_market_not_matched',
  }
}

@Injectable()
export class MarketValidityService {
  async evaluateRatePlanValidity(
    prisma: PrismaService,
    tenantId: string,
    ratePlanId: string,
    sourceMarketCountryCode: string
  ): Promise<{ isValid: boolean; matchedRuleId: string | null; reason: string }> {
    const loadRatePlan = (tx: Pick<PrismaService, 'ratePlan'>) =>
      tx.ratePlan.findUnique({
        where: { id: ratePlanId, tenantId },
        include: {
          contract: {
            include: {
              marketValidityRules: {
                where: { tenantId, ratePlanId: null },
                include: { marketGroup: true },
              },
            },
          },
          marketValidityRules: {
            where: { tenantId },
            include: { marketGroup: true },
          },
        },
      })

    const ratePlan =
      typeof prisma.withTenant === 'function'
        ? await prisma.withTenant(tenantId, (tx) => loadRatePlan(tx as unknown as Pick<PrismaService, 'ratePlan'>))
        : await loadRatePlan(prisma)

    if (!ratePlan || (ratePlan.tenantId && ratePlan.tenantId !== tenantId)) {
      return { isValid: false, matchedRuleId: null, reason: 'rate_plan_not_found' }
    }

    const contractRules = (ratePlan.contract?.marketValidityRules ?? []).filter(
      (rule) => !rule.ratePlanId || rule.ratePlanId === ratePlanId
    )

    return evaluateMarketRules(
      ratePlan.marketValidityRules ?? [],
      contractRules,
      sourceMarketCountryCode
    )
  }
}
