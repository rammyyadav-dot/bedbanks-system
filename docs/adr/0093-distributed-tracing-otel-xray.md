# ADR 0093: Distributed tracing with OpenTelemetry and AWS X-Ray

Status: proposed (nothing applied to AWS; Terraform was not available to validate the HCL). Extends ADR 0040 and ADR 0056.

## Context
A multi-supplier search fans out to every supplier (ADR 0075) under one deadline. Today a slow search leaves one `supplier_leg` log line per supplier, with no way to see, per request, which leg was slow, what ran inside it, or how it relates to the portal, the load balancer and the rest of the API request.

## Decision
1. **OpenTelemetry in the API and the Agent, Admin and Supplier portals, vendor-neutral in code.** The SDK setup lives in one shared package, `@bedbanks/tracing` (`startTracing`): X-Ray ids and propagation, sampling, the http instrumentation, URL scrubbing and the OTLP export. The API adds express and NestJS instrumentations and registers it as the first import of `main.ts`; each portal registers it from `instrumentation.ts` (Node runtime only). Off unless `OTEL_TRACING_ENABLED=true`, so development, tests and un-migrated environments are unchanged. The connector, domain, pricing and money packages do not import OpenTelemetry (dependency direction): the one place that knows about suppliers and the API, `AggregatingSupplierAdapter`, creates the supplier spans. The website is not traced (no API dependency, no tenant data).
   - **Portal build.** The OpenTelemetry packages patch Node modules at load time and cannot be bundled, so each portal lists them in `serverExternalPackages` and declares them as dependencies (pnpm only exposes declared packages to Next's externals; verified with standalone builds of all three portals).
2. **Span model for supplier aggregation.** `supplier.fanout.search` (attributes: supplier count, deadline, queried/succeeded/failed, offer count; one `supplier_leg` event per leg with outcome and duration) with one child `supplier.search` per supplier. The widest child is the bottleneck. A leg that outlives the deadline is visible as a child that ends after its parent.
3. **AWS transport.** X-Ray trace ids and `X-Amzn-Trace-Id` propagation, so a trace started by the ALB continues in the API. Spans go over OTLP/HTTP to an **ADOT collector sidecar** in the `api` task (`localhost:4318`), which exports to X-Ray under the api task role (write-only X-Ray actions). The sidecar is `essential = false`: a collector outage drops traces and never takes the API down. Sampling is parent-based with a root ratio (default 10%; a malformed ratio falls back to 10%, never to 100%).
4. **Correlation.** The active span carries `app.request_id` (the existing `X-Request-ID`), and the default `supplier_leg` log line carries `traceId`, so logs, audit payloads and traces join on either id.
5. **Data minimisation (invariant 7).** Spans carry supplier ids, counts, durations and enumerated error codes only. No search criteria, guest data, offers, headers, bodies or error messages. URL attributes (`http.url`, `http.target`, `url.full`, `url.path`, `url.query`) are rewritten to scheme, host and path (query strings dropped) by a span processor that runs on every span before export, because supplier URLs and reset links can carry credentials; Next.js' own spans carry the query too, which a per-instrumentation hook missed in testing. Health probes are not traced.

## Not done / follow-ups
- **Portal spans are Next.js' defaults** (middleware, route and render spans plus outgoing http). No portal business spans were added.
- **ALB-to-portal linking:** not possible with the ALB's header (see decision 3).
- **Existing environments:** Terraform only owns the first task definition revision (`ignore_changes`), and CI copies the latest revision. Enabling tracing there means registering one revision that adds the sidecar and the `OTEL_*` variables (runbook), or a one-time `terraform apply` on a new environment.
- **Per-supplier connector internals** (parsing, gate wait) are not separate spans yet.
- The ADOT image tag is not digest-pinned and the built-in config path `/etc/ecs/ecs-xray.yaml` was not verified against a running collector; both need confirming in staging.

## Verification
Unit tests cover span structure, error codes, absence of criteria in spans, URL scrubbing and sampling configuration. Standalone builds of the agent, admin and supplier portals were run with tracing on against a fake API and a fake OTLP receiver: spans were exported, the API received `X-Amzn-Trace-Id` with `Sampled=1`, health probes were not traced, and a secret query string was absent from every export. Not verified: `terraform validate/plan`, a live collector, X-Ray ingestion.
