export declare const SESSION_EXPIRED_EVENT: string
export declare function announceSessionExpired(target?: Pick<EventTarget, 'dispatchEvent'> | null): void
/** Paths whose 401 means "not signed in" or "wrong credentials", never "session expired". */
export declare const NON_EXPIRING_PATHS: readonly string[]
