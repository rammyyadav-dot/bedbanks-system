# Runbook: connector secrets (ADR 0085)

Nothing resolves secrets until you configure this. No supplier is wired to the resolver yet.

1. **Choose the prefix** and set `CONNECTOR_SECRETS_PREFIX` on the API task (for example `fbeds-prod/connectors`). Lowercase path, no trailing slash. Unset means the resolver is off and the admin API refuses to store a credential reference.
2. **Name every secret** `<prefix>/<tenantId>/<connectorId>/<anything>` in Secrets Manager, with a JSON object of string values, for example `{"user":"...","password":"..."}` (at most 20 keys, 8 KiB). Put the value there yourself; the API never writes a secret.
3. **Scope IAM** so the API task role can call `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:<region>:<account>:secret:<prefix>/*` and nothing else (never the `api/` secrets). This change does not edit the infrastructure code.
4. **Attach** with `POST /supply/connectors/:id/credential-references` `{ "purpose": "api", "secretRef": "aws-sm:<prefix>/<tenantId>/<connectorId>/credentials" }`. Request activation, have a second person approve, then execute; execution refuses until the secret exists and is well formed.
5. **Rotate** by suspending the connector, writing the new secret (a new leaf name, then re-attach, or the same name and wait for the cache time, `CONNECTOR_SECRET_CACHE_MS`, default 60 s), and reactivating through approval.

Strict runtime role deployments: connector writes answer the typed 403 until the narrow connector-admin role exists (ADR 0085, "Authority").
