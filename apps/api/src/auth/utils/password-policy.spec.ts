import { passwordPolicyProblem } from './password-policy'

describe('passwordPolicyProblem', () => {
  const email = 'ops.manager@satguru.example'
  it('accepts a long passphrase', () => expect(passwordPolicyProblem('correct horse battery staple', email)).toBeNull())
  it('rejects short, oversized, email-derived, repeated and common passwords', () => {
    expect(passwordPolicyProblem('Short1!', email)).toMatch(/at least 12/)
    expect(passwordPolicyProblem('x'.repeat(129), email)).toMatch(/at most 128/)
    expect(passwordPolicyProblem(email, email)).toMatch(/email/)
    expect(passwordPolicyProblem('xx-ops.manager-xx', email)).toMatch(/email/)
    expect(passwordPolicyProblem('aaaaaaaaaaaaaaaa', email)).toMatch(/variety/)
    expect(passwordPolicyProblem('Password12345!', email)).toMatch(/easy to guess/)
  })
  it('does not apply composition rules to a long password', () => expect(passwordPolicyProblem('alllowercasewordsonly', email)).toBeNull())
})
