import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray'
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import { sampleRatio, tracingEnabled, type Env } from './config'
import { UrlScrubbingSpanProcessor } from './url-scrub'

const HEALTH_PATH = /\/health(?:$|[/?])/

export interface StartTracingOptions {
  /** Default service name; `OTEL_SERVICE_NAME` wins so Terraform can name it per environment. */
  serviceName: string
  /** Framework instrumentations on top of http (express, NestJS). */
  instrumentations?: Instrumentation[]
  env?: Env
}

let provider: NodeTracerProvider | undefined

/**
 * Starts OpenTelemetry for one Node process (ADR 0093). Off unless OTEL_TRACING_ENABLED=true. Call it before the framework loads,
 * because the http instrumentation patches modules as they are required. Spans go over OTLP/HTTP to the ADOT collector sidecar
 * (OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318), which forwards to AWS X-Ray.
 *
 * Built on the tracer provider rather than `@opentelemetry/sdk-node`, which drags in Prometheus and Jaeger packages that this service
 * does not use and that carry unpatched advisories.
 */
export function startTracing(options: StartTracingOptions): boolean {
  const env = options.env ?? process.env
  if (!tracingEnabled(env) || provider) return false
  // The load balancer's X-Amzn-Trace-Id carries `Root=` without a `Sampled` flag, which reads as "not sampled". Honour a sampled
  // parent, but for anything else decide here, otherwise every request that enters through the ALB would be dropped.
  const ratio = new TraceIdRatioBasedSampler(sampleRatio(env))
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': env.OTEL_SERVICE_NAME || options.serviceName }),
    idGenerator: new AWSXRayIdGenerator(),
    sampler: new ParentBasedSampler({ root: ratio, remoteParentNotSampled: ratio }),
    // The scrubber must come first: processors run in order and the exporting one reads the span as the scrubber left it.
    spanProcessors: [new UrlScrubbingSpanProcessor(), new BatchSpanProcessor(new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318'}/v1/traces` }))],
  })
  provider.register({ propagator: new AWSXRayPropagator() })
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        // Load-balancer health probes would dominate the trace volume and carry no information.
        ignoreIncomingRequestHook: req => HEALTH_PATH.test(req.url ?? ''),
      }),
      ...(options.instrumentations ?? []),
    ],
  })
  // Flush buffered spans when ECS stops the task (SIGTERM), after the app's own drain has begun.
  process.once('SIGTERM', () => { void provider?.shutdown() })
  return true
}
