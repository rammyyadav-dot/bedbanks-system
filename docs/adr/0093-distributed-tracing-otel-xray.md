# ADR 0093: Distributed tracing with OpenTelemetry and AWS X-Ray

Status: proposed (nothing applied to AWS; Terraform was not available to validate the HCL). Extends ADR 0040 and ADR 0056.

## Context
A multi-supplier search fans out to every supplier (ADR 0075) under one deadline. Today a slow search leaves one `supplier_leg` log line per supplier, with no way to see, per request, which leg was slow, what ran inside it, or how it relates to the portal, the load balancer and the rest of the API request.

## Decision
1. **OpenTelemetry in the API only, vendor-neutral in code.** `apps/api/src/observability/` registers the Node SDK before Nest loads (`tracing-bootstrap.ts`, first import of `main.ts`) with http, express and NestJS instrumentations. Off unless `OTEL_TRACING_ENABLED=true`, so development, tests and un-migrated environments are unchanged. Packages (`@bedbanks/connectors-*`, domain, pricing, money) do not import OpenTelemetry (dependency direction): the one place that knows about suppliers and the API, `AggregatingSupplierAdapter`, creates the spans.
2. **Span model for supplier aggregation.** `supplier.fanout.search` (attributes: supplier count, deadline, queried/succeeded/failed, offer count; one `supplier_leg` event per leg with outcome and duration) with one child `supplier.search` per supplier. The widest child is the bottleneck. A leg that outlives the deadline is visible as a child that ends after its parent.
3. **AWS transport.** X-Ray trace ids and `X-Amzn-Trace-Id` propagation, so a trace started by the ALB continues in the API. Spans go over OTLP/HTTP to an **ADOT collector sidecar** in the `api` task (`localhost:4318`), which exports to X-Ray under the api task role (write-only X-Ray actions). The sidecar is `essential = false`: a collector outage drops traces and never takes the API down. Sampling is parent-based with a root ratio (default 10%; a malformed ratio falls back to 10%, never to 100%).
4. **Correlation.** The active span carries `app.request_id` (the existing `X-Request-ID`), and the default `supplier_leg` log line carries `traceId`, so logs, audit payloads and traces join on either id.
5. **Data minimisation (invariant 7).** Spans carry supplier ids, counts, durations and enumerated error codes only. No search criteria, guest data, offers, headers, bodies or error messages. URL attributes are rewritten to scheme, host and path (query strings dropped) on both incoming and outgoing HTTP, because supplier URLs and reset links can carry credentials. Health probes are not traced.

## Not done / follow-ups
- **Portals (Next.js)** do not emit spans; the trace starts at the ALB or the API. Propagating through the portal proxy and instrumenting the portals is a separate change.
- **Existing environments:** Terraform only owns the first task definition revision (`ignore_changes`), and CI copies the latest revision. Enabling tracing there means registering one revision that adds the sidecar and the `OTEL_*` variables (runbook), or a one-time `terraform apply` on a new environment.
- **Per-supplier connector internals** (parsing, gate wait) are not separate spans yet.
- The ADOT image tag is not digest-pinned and the built-in config path `/etc/ecs/ecs-xray.yaml` was not verified against a running collector; both need confirming in staging.

## Verification
Unit tests cover span structure, error codes, absence of criteria in spans, URL scrubbing and sampling configuration. A local smoke run with the real SDK against a fake OTLP receiver confirmed export and that a secret query string is absent. Not verified: `terraform validate/plan`, a live collector, X-Ray ingestion.
