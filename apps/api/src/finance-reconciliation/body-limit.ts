import type { INestApplication } from '@nestjs/common'
import { json } from 'express'
import { routes } from '@bedbanks/contracts'

/**
 * A statement of 5,000 lines is about 400 KB of JSON (up to 750 KB with long references); Express's default of 100 KB would refuse anything over roughly
 * 1,300 lines. Only the statement routes get the larger limit; every other route keeps the default.
 *
 * Order and the second `use` matter. A body-parser skips a request whose body is already parsed, so the large parser is mounted first and wins on the
 * statement routes. But Nest installs its own global JSON parser only when no layer named `jsonParser` exists yet, and this one has that name: mounting
 * the large parser alone would silently leave every other route without body parsing. The default parser is therefore mounted here, explicitly.
 */
export const STATEMENT_BODY_LIMIT = '1mb'
/** A bank statement is sent as text inside JSON (up to 1,500,000 characters; characters can be multi-byte and quotes are escaped). */
export const BANK_STATEMENT_BODY_LIMIT = '4mb'

export function configureJsonBodyLimits(app: INestApplication, apiPrefix: string): void {
  app.use(`/${apiPrefix.replace(/^\/+|\/+$/g, '')}${routes.adminFinanceReconciliation.statements}`, json({ limit: STATEMENT_BODY_LIMIT }))
  app.use(`/${apiPrefix.replace(/^\/+|\/+$/g, '')}${routes.adminBankReconciliation.statements}`, json({ limit: BANK_STATEMENT_BODY_LIMIT }))
  app.use(json())
}
