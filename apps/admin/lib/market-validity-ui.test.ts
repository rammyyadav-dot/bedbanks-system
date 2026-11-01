import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blankRuleDraft,
  buildMarketValidityRuleWrite,
  describeEvaluationReason,
  describeMarketValidityRule,
  mergeSelectedAndCustomCountries,
  toggleCountrySelection,
} from './market-validity-ui'

test('toggleCountrySelection adds, removes and sorts valid ISO alpha-2 codes', () => {
  const step1 = toggleCountrySelection([], 'sa')
  assert.deepEqual(step1, ['SA'])
  const step2 = toggleCountrySelection(step1, 'AE')
  assert.deepEqual(step2, ['AE', 'SA'])
  const step3 = toggleCountrySelection(step2, 'sa')
  assert.deepEqual(step3, ['AE'])
  assert.deepEqual(toggleCountrySelection(step3, 'INVALID'), ['AE'])
})

test('mergeSelectedAndCustomCountries combines chip selection and comma-separated input and reports invalid codes', () => {
  assert.deepEqual(mergeSelectedAndCustomCountries(['AE', 'SA'], 'qa, om, ae'), {
    codes: ['AE', 'OM', 'QA', 'SA'],
    invalid: [],
  })
  assert.deepEqual(mergeSelectedAndCustomCountries(['AE'], 'GBR, IN'), {
    codes: ['AE', 'IN'],
    invalid: ['GBR'],
  })
})

test('buildMarketValidityRuleWrite validatesCOUNTRY_CODE, MARKET_GROUP and WORLDWIDE shapes', () => {
  assert.equal(
    buildMarketValidityRuleWrite({ ...blankRuleDraft, matchType: 'COUNTRY_CODE', selectedCountries: [], customCountries: '' }),
    'Select or enter at least one two-letter ISO country code.'
  )
  assert.equal(
    buildMarketValidityRuleWrite({ ...blankRuleDraft, matchType: 'MARKET_GROUP', marketGroupId: '' }),
    'Select a source market group.'
  )
  assert.deepEqual(
    buildMarketValidityRuleWrite({
      ...blankRuleDraft,
      ratePlanId: 'rp-1',
      inclusionType: 'EXCLUDE',
      matchType: 'COUNTRY_CODE',
      selectedCountries: ['AE'],
      customCountries: 'sa',
    }),
    {
      ratePlanId: 'rp-1',
      inclusionType: 'EXCLUDE',
      matchType: 'COUNTRY_CODE',
      countryCodes: ['AE', 'SA'],
      marketGroupId: null,
    }
  )
  assert.deepEqual(
    buildMarketValidityRuleWrite({
      ...blankRuleDraft,
      ratePlanId: '',
      inclusionType: 'INCLUDE',
      matchType: 'WORLDWIDE',
    }),
    {
      ratePlanId: null,
      inclusionType: 'INCLUDE',
      matchType: 'WORLDWIDE',
      countryCodes: [],
      marketGroupId: null,
    }
  )
})

test('describeMarketValidityRule and describeEvaluationReason format rules and verdicts clearly', () => {
  const desc = describeMarketValidityRule(
    {
      id: 'r1',
      tenantId: 't1',
      contractId: 'c1',
      ratePlanId: 'rp1',
      inclusionType: 'INCLUDE',
      matchType: 'MARKET_GROUP',
      countryCodes: [],
      marketGroupId: 'g1',
      marketGroup: {
        id: 'g1',
        tenantId: 't1',
        code: 'GCC',
        name: 'Gulf Cooperation Council',
        countryCodes: ['AE', 'SA'],
        isActive: true,
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
      },
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    },
    (id) => (id === 'rp1' ? 'BAR-GCC' : id)
  )
  assert.equal(desc.scopeLabel, 'Rate Plan: BAR-GCC')
  assert.equal(desc.actionLabel, 'INCLUDE (Allow)')
  assert.match(desc.targetLabel, /Group GCC/)
  assert.match(describeEvaluationReason('explicitly_excluded_by_source_market'), /EXCLUDE rule matched/)
})
