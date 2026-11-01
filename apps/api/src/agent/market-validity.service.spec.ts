import { MarketValidityService } from './market-validity.service'
import type { PrismaService } from '../database/prisma.service'

describe('MarketValidityService (ADR 0107)', () => {
  const service = new MarketValidityService()

  const mockPrisma = (ratePlan: unknown) =>
    ({
      withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          ratePlan: {
            findUnique: jest.fn().mockResolvedValue(ratePlan),
          },
        }),
    }) as unknown as PrismaService

  it('returns rate_plan_not_found when the rate plan does not exist', async () => {
    const result = await service.evaluateRatePlanValidity(mockPrisma(null), 't1', 'rp-missing', 'AE')
    expect(result).toEqual({
      isValid: false,
      matchedRuleId: null,
      reason: 'rate_plan_not_found',
    })
  })

  it('defaults to worldwide_default when neither rate plan nor contract has rules', async () => {
    const ratePlan = {
      id: 'rp1',
      tenantId: 't1',
      marketValidityRules: [],
      contract: { marketValidityRules: [] },
    }
    const result = await service.evaluateRatePlanValidity(mockPrisma(ratePlan), 't1', 'rp1', 'IN')
    expect(result).toEqual({
      isValid: true,
      matchedRuleId: null,
      reason: 'worldwide_default',
    })
  })

  it('matches contract-level MARKET_GROUP inclusion rules when rate plan has no explicit rules', async () => {
    const ratePlan = {
      id: 'rp1',
      tenantId: 't1',
      marketValidityRules: [],
      contract: {
        marketValidityRules: [
          {
            id: 'rule-gcc',
            inclusionType: 'INCLUDE',
            matchType: 'MARKET_GROUP',
            countryCodes: [],
            marketGroupId: 'grp-gcc',
            marketGroup: {
              id: 'grp-gcc',
              code: 'GCC',
              name: 'Gulf Cooperation Council',
              countryCodes: ['AE', 'SA', 'QA', 'OM', 'BH', 'KW'],
              isActive: true,
            },
          },
        ],
      },
    }

    await expect(service.evaluateRatePlanValidity(mockPrisma(ratePlan), 't1', 'rp1', 'ae')).resolves.toEqual({
      isValid: true,
      matchedRuleId: 'rule-gcc',
      reason: 'valid_source_market_match',
    })

    await expect(service.evaluateRatePlanValidity(mockPrisma(ratePlan), 't1', 'rp1', 'GB')).resolves.toEqual({
      isValid: false,
      matchedRuleId: null,
      reason: 'source_market_not_matched',
    })
  })

  it('overrides contract-level rules when explicit rate-plan rules exist', async () => {
    const ratePlan = {
      id: 'rp-india',
      tenantId: 't1',
      marketValidityRules: [
        {
          id: 'rule-in-only',
          ratePlanId: 'rp-india',
          inclusionType: 'INCLUDE',
          matchType: 'COUNTRY_CODE',
          countryCodes: ['IN'],
          marketGroupId: null,
          marketGroup: null,
        },
      ],
      contract: {
        marketValidityRules: [
          {
            id: 'rule-contract-ae',
            ratePlanId: null,
            inclusionType: 'INCLUDE',
            matchType: 'COUNTRY_CODE',
            countryCodes: ['AE'],
            marketGroupId: null,
            marketGroup: null,
          },
        ],
      },
    }

    await expect(service.evaluateRatePlanValidity(mockPrisma(ratePlan), 't1', 'rp-india', 'IN')).resolves.toEqual({
      isValid: true,
      matchedRuleId: 'rule-in-only',
      reason: 'valid_source_market_match',
    })

    await expect(service.evaluateRatePlanValidity(mockPrisma(ratePlan), 't1', 'rp-india', 'AE')).resolves.toEqual({
      isValid: false,
      matchedRuleId: null,
      reason: 'source_market_not_matched',
    })
  })

  it('enforces EXCLUDE rules with absolute fail-safe precedence over INCLUDE / WORLDWIDE rules', async () => {
    const ratePlan = {
      id: 'rp-worldwide-ex-domestic',
      tenantId: 't1',
      marketValidityRules: [
        {
          id: 'rule-worldwide',
          inclusionType: 'INCLUDE',
          matchType: 'WORLDWIDE',
          countryCodes: [],
          marketGroupId: null,
          marketGroup: null,
        },
        {
          id: 'rule-exclude-ae',
          inclusionType: 'EXCLUDE',
          matchType: 'COUNTRY_CODE',
          countryCodes: ['AE'],
          marketGroupId: null,
          marketGroup: null,
        },
      ],
      contract: { marketValidityRules: [] },
    }

    await expect(
      service.evaluateRatePlanValidity(mockPrisma(ratePlan), 't1', 'rp-worldwide-ex-domestic', 'GB')
    ).resolves.toEqual({
      isValid: true,
      matchedRuleId: 'rule-worldwide',
      reason: 'valid_source_market_match',
    })

    await expect(
      service.evaluateRatePlanValidity(mockPrisma(ratePlan), 't1', 'rp-worldwide-ex-domestic', 'AE')
    ).resolves.toEqual({
      isValid: false,
      matchedRuleId: 'rule-exclude-ae',
      reason: 'explicitly_excluded_by_source_market',
    })
  })
})
