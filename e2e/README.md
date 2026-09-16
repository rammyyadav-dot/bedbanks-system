# End-to-end release suite

This directory is reserved for browser and database-backed release tests: authentication, tenant isolation, booking lifecycle and idempotency concurrency. The current tenant guard unit suite is a temporary CI gate; full PostgreSQL and browser suites are added with P0-E and booking implementation, not as empty placeholder tests.
