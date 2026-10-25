/**
 * Distributed tracing (ADR 0093). Import this FIRST in main.ts: the http and express instrumentations patch modules as they are
 * required, so they must be registered before Nest loads them.
 *
 * Off unless OTEL_TRACING_ENABLED=true. On ECS Fargate the task runs an AWS Distro for OpenTelemetry collector sidecar; spans go
 * to it over OTLP/HTTP on localhost (OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318) and the collector forwards to
 * AWS X-Ray. Trace ids use the X-Ray format and the X-Amzn-Trace-Id header is propagated, so a trace started at the ALB continues here.
 */
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray'
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import { scrubSpanUrlAttributes } from './url-scrub'

const HEALTH_PATH = /\/health(?:$|[/?])/

export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OTEL_TRACING_ENABLED === 'true'
}

/** Fraction of root requests sampled (0..1). A malformed value falls back to 10%, never to "trace everything". */
export function sampleRatio(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OTEL_TRACE_SAMPLE_RATIO
  if (raw === undefined || raw === '') return 0.1
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.1
}

let sdk: NodeSDK | undefined

export function startTracing(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!tracingEnabled(env) || sdk) return false
  sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME || 'fbeds-api',
    idGenerator: new AWSXRayIdGenerator(),
    textMapPropagator: new AWSXRayPropagator(),
    // Parent-based: a request the ALB or a portal already sampled stays sampled end to end.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio(env)) }),
    traceExporter: new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318'}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({
        // Load-balancer health probes would dominate the trace volume and carry no information.
        ignoreIncomingRequestHook: req => HEALTH_PATH.test(req.url ?? ''),
        requestHook: (span, request) => {
          // Incoming requests expose `url`; outgoing (supplier) requests expose `path` and the target in `host`/`hostname`.
          const incoming = request as { url?: string; path?: string; protocol?: string; host?: string }
          scrubSpanUrlAttributes(span, incoming.url ?? incoming.path)
        },
      }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
    ],
  })
  sdk.start()
  // Flush buffered spans when ECS stops the task (SIGTERM), after the app's own drain has begun.
  process.once('SIGTERM', () => { void sdk?.shutdown() })
  return true
}

startTracing()
