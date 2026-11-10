# Changelog

All changes to the contract and the packages are listed here. The format follows Keep a Changelog, and the versions follow Semantic Versioning.

## Unreleased

### Added

- The design decisions of release 1.0 (`docs/decisions.md`): the owner decisions of 2026-11-10 and each refinement.
- Contract version 1. It adds tagged read results, per-entry `setMany` outcomes, the privacy rule (S13) and the limits `maxValueBytes` and `maxBatchSize` (S14).
- The error codes `invalid_batch`, `value_too_large`, `batch_too_large` and `schema`.
- The contract sections of the capabilities #15 and #18 to #22 (`docs/spec-1.0.md`, R17 to R22).
- The RED metrics `kvpg.operation.calls` and `kvpg.operation.errors` in the telemetry contract.
- `bench/prefix-plan.mjs`: the plans of the prefix delete on PostgreSQL 15 to 18.
- The contract payloads in `contracts/` (JSON Schema 2020-12) with valid and invalid samples, the gate test and the drift test.
- The contract types of version 1: `ReadResult`, `WriteOutcome`, `Limits`, `CleanupOptions`, `KV_ERROR_CODES`, `OPERATIONS`, `StoreOptions` and `PostgresStore`.
- Telemetry conformance assertions and pending store tests, with an in-memory exporter harness and tests for both Prometheus routes.
- The combined 1.0 specification (`docs/spec-1.0.md`), with behavior, implementation logic, acceptance tests, and open owner decisions.
- The native telemetry specification (`docs/telemetry.md`), with open owner choices for the default and supported API/SDK versions.
- The cache contract, version 0 (`docs/standard.md`), and its TypeScript types.
- The extension points: driver, codec, hooks, cleanup policy and table options.
- The design of the PostgreSQL store (`docs/design.md`).

### Changed

- The telemetry contract follows the owner decisions: on with a registered provider, a no-op without one, an off switch for each store, API 1.9 and later with SDK 2.
- `deletePrefix` uses a key range with a code point upper bound.
- `setMany` is one SQL statement, so a `pg` Client is enough for every operation.
- The telemetry tests use the SDK 2 generation: `sdk-trace-base` 2 and the logs of `@opentelemetry/api-logs`.
- The hook types carry safe fields only: `OperationEvent.errorCode` replaces the error object, and `onHookError` gets `{ code: 'hook' }`.
- `expire` without `ttlMs` and `expiresAt` rejects with `invalid_ttl`.
- `npm test` builds the package first and runs the contract tests.
