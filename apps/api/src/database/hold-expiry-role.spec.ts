import { assertProvisioningInput, describePasswordProblems } from './hold-expiry-role'

describe('describePasswordProblems', () => {
  it('reports nothing for a valid password', () => {
    expect(describePasswordProblems('a'.repeat(32))).toEqual([])
    expect(assertProvisioningInput('fbeds_hold_expiry_login', `${'Ab1_-'.repeat(8)}`)).toBeUndefined()
  })

  it('explains a short password with its length only', () => {
    expect(describePasswordProblems('short-but-valid-chars')).toEqual(['it is 21 characters long; at least 32 are needed'])
  })

  it('counts characters outside the allowed set without revealing them', () => {
    const problems = describePasswordProblems(`${'a'.repeat(40)} !\n`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('3 characters are not a letter, digit, hyphen or underscore')
    expect(problems[0]).not.toContain('!')
  })

  it('reports both problems together and handles an empty value', () => {
    expect(describePasswordProblems('pass word')).toHaveLength(2)
    expect(describePasswordProblems('')).toEqual(['it is 0 characters long; at least 32 are needed'])
  })
})
