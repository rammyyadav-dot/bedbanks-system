/**
 * An API call that finds the session gone (401) while the agent is signed in tells the auth gate, which returns to the sign-in screen with the
 * expired-session notice. Login and the initial context probe do not announce: a visitor who was never signed in is not "expired".
 */
export const SESSION_EXPIRED_EVENT = 'fbeds:session-expired'

export function announceSessionExpired(target = typeof window === 'undefined' ? null : window) {
  target?.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}

/** Paths whose 401 means "not signed in" or "wrong credentials", never "session expired". */
export const NON_EXPIRING_PATHS = ['/auth/login', '/agent/context']
