export function signInErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Invalid sign-in details') {
    return 'Enter a valid work email and password.'
  }
  if (message === 'Invalid credentials' || message === 'Session expired') {
    return 'We could not sign you in. Check your credentials and try again.'
  }
  if (message === 'Access denied') return 'This account cannot open the agent workspace.'
  return 'Sign-in is temporarily unavailable. Retry when you are ready.'
}
