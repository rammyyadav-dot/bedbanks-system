# Distributed tracing runbook (ADR 0093)

## Enable (new environment)
Set `tracing_enabled = true` (and optionally `tracing_sample_ratio`) in the environment's tfvars, then plan and apply. The api, admin, agent and supplier tasks each get the ADOT collector sidecar, the `OTEL_*` variables and X-Ray write permission on their own task role (the website is not traced).

## Enable (existing environment, CI-owned task definitions)
For each of `api`, `admin`, `agent`, `supplier`, register one new task definition revision from the current one that adds: the `adot-collector` container (`essential: false`, command `--config=/etc/ecs/ecs-xray.yaml`, same log group, prefix `adot`), and these environment variables on the service container: `OTEL_TRACING_ENABLED=true`, `OTEL_SERVICE_NAME=fbeds-<service>-<env>`, `OTEL_TRACE_SAMPLE_RATIO=0.1`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`. Each task role also needs the X-Ray write policy (apply the Terraform `xray` policy). Later deploys keep the sidecar because the deploy workflow only swaps the named container's image.
Roll back by setting `OTEL_TRACING_ENABLED=false`; no code change.

## Find the slow supplier
1. CloudWatch > X-Ray traces > services `fbeds-<service>-<env>`; filter by span name `supplier.fanout.search`.
2. A portal request that reaches the API is one trace (portal service, then `fbeds-api-<env>`). Open a slow trace. Children named `supplier.search` carry `supplier.id`; the longest one is the bottleneck. Check its `supplier.timeout_ms` against its duration, and `error.code` for failures.
3. The fan-out span's `supplier_leg` events list each leg's outcome and duration; `supplier.failed` > 0 means a partial answer.
4. From a user report: search traces by `app.request_id` (the `X-Request-ID` the caller received), or from a log line by its `traceId`.

## If no traces appear
Check the `adot` log stream in the api log group; confirm `OTEL_TRACING_ENABLED=true` on the running revision; confirm the task role has the X-Ray policy; remember only 10% of root requests are sampled by default.
