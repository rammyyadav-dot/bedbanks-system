import test from 'node:test'
import assert from 'node:assert/strict'
import { nextStep, summariseSteps, WIZARD_STEPS } from './rate-plan-wizard'

const check = (code: string, ok: boolean) => ({ code, label: code, ok, message: ok ? 'fine' : `fix ${code}` })

test('every server check lands on exactly one step', () => {
  const all = WIZARD_STEPS.flatMap((s) => s.codes)
  assert.equal(new Set(all).size, all.length)
})

test('a step needs attention while any of its checks fails, and lists them', () => {
  const s = summariseSteps([check('PLAN_VALIDITY', true), check('RATES_PRESENT', false), check('RATES_POSITIVE', true), check('PROMOTIONS_VALID', true)])
  const by = Object.fromEntries(s.map((x) => [x.step.key, x]))
  assert.equal(by.terms!.state, 'ready'); assert.equal(by.terms!.passing, 1)
  assert.equal(by.pricing!.state, 'attention'); assert.deepEqual(by.pricing!.failing.map((c) => c.code), ['RATES_PRESENT'])
  assert.equal(by.extras!.state, 'ready')
  assert.equal(by.review!.state, 'ready')
})

test('a check the wizard does not know is never hidden: it lands on review', () => {
  const s = summariseSteps([check('SOME_FUTURE_RULE', false)])
  assert.equal(s.find((x) => x.step.key === 'review')!.state, 'attention')
  assert.deepEqual(s.find((x) => x.step.key === 'review')!.failing.map((c) => c.code), ['SOME_FUTURE_RULE'])
})

test('the next step is the first one that needs attention, else review', () => {
  assert.equal(nextStep(summariseSteps([check('PLAN_VALIDITY', false), check('RATES_PRESENT', false)])), 'terms')
  assert.equal(nextStep(summariseSteps([check('PLAN_VALIDITY', true), check('RATES_PRESENT', false)])), 'pricing')
  assert.equal(nextStep(summariseSteps([check('PLAN_VALIDITY', true), check('RATES_PRESENT', true)])), 'review')
  assert.equal(nextStep(summariseSteps([])), 'review')
})
