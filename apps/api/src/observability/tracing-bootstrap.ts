/**
 * Distributed tracing (ADR 0093). Import this FIRST in main.ts: the http and express instrumentations patch modules as they are
 * required, so they must be registered before Nest loads them. The SDK, sampling, X-Ray ids and URL scrubbing are shared with the
 * portals in @bedbanks/tracing; only the API-specific framework instrumentations live here.
 */
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core'
import { startTracing } from '@bedbanks/tracing'

startTracing({ serviceName: 'fbeds-api', instrumentations: [new ExpressInstrumentation(), new NestInstrumentation()] })
