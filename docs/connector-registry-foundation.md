# Connector registry foundation

`ConnectorDefinition` declares an intended supplier transport: JSON API, XML in/out, channel manager or manual extranet. It records capabilities and health state but does not execute a real integration.

## Secret policy

`ConnectorCredentialReference.secretRef` stores only an approved secret-manager reference. Plaintext passwords, API keys, tokens, cookies and supplier credentials are prohibited from database records, logs, fixtures, audit payloads and documentation. The database check rejects obvious credential-like values; a real secret-manager integration remains a separate operations task.

## Future adapter boundary

Future adapters must accept a server-derived tenant and connector ID, resolve credentials only at runtime from the approved secret manager, emit redacted `ConnectorExecution` and `InventoryUpdateEvent` records, and use idempotency keys for inbound changes. An adapter must not return invented hotel availability or booking confirmation when a provider is unavailable.

## Audit and RLS

Connector definitions, executions and inventory update events are tenant-scoped under RLS. Credential references inherit tenant scope through their connector. Error classification and validation errors are operational metadata only and must be redacted before persistence.

## Not implemented

No connector process, credential, polling schedule, webhook receiver, XML parser, live inventory sync, booking action or deployment is implemented by this foundation.
