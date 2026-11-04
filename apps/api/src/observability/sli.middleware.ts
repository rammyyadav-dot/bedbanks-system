import { Injectable, NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { buildSliRecord, writeSli } from './sli'

/** Emits one SLI line when the response finishes. Registered after the request-id middleware. */
@Injectable()
export class SliMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint()
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6
      const routePath = typeof req.route?.path === 'string' ? req.route.path : undefined
      const record = buildSliRecord({
        method: req.method,
        baseUrl: req.baseUrl,
        routePath,
        path: routePath ? undefined : req.path,
        status: res.statusCode,
        durationMs,
        requestId: req.requestId,
      })
      if (record) writeSli(record)
    })
    next()
  }
}
