# Design decisions for kvpg 1.0

This file records each owner decision and each design refinement of release 1.0.
An owner decision (OD) is binding. A refinement (RF) is a choice of the design, inside the owner decisions.
No refinement weakens an owner decision.
Each entry gives the decision, the reason and the source.
The documents that state each rule are `docs/standard.md` (S1 to S14), `docs/spec-1.0.md` (R01 to R23) and `docs/telemetry.md` (T01 to T13).

## Owner decisions

### OD1. Release scope (#1)

Decision: release 1.0 includes all open work: #2 to #7, #11 to #14, #16, #17, and the features #15 and #18 to #22.
Each feature gets its own contract section, its negative tests and its recovery tests.
#7 measures D1, D5 and D6. The draft defaults stay unless the data shows otherwise.

Source: [#1 comment, 2026-11-10 03:28 UTC](https://github.com/inkcasthq/kvpg/issues/1#issuecomment-6758155013).
Where: spec-1.0.md R01, R02, R17 to R22.

### OD2. Telemetry default (#6)

Decision: if the application registered an OpenTelemetry provider, telemetry is on.
With no provider, each call is a no-op with zero telemetry work.
Each store instance has an off switch.
The conformance suite tests all three states.

Source: [#6 comment, 2026-11-10 03:20 UTC](https://github.com/inkcasthq/kvpg/issues/6#issuecomment-6758119045).
Where: telemetry.md T03. RF12 defines "provider registered" and "no-op" in testable terms.

### OD3. Conditional batches and repeated keys (#11)

Decision: a batch write with `ifAbsent` returns one result for each entry, `written` or `exists`.
If a key is two or more times in one batch write, the batch fails with `invalid_batch` before any write.

Source: [#11 comment, 2026-11-10 03:20 UTC](https://github.com/inkcasthq/kvpg/issues/11#issuecomment-6758118286).
Where: standard.md S7 and S12, spec-1.0.md R08.

### OD4. Tagged read result (#12)

Decision: `get` returns `{ found: true, value }` or `{ found: false }`.
A stored `undefined` is different from a missing key.
The contract states each permitted codec round trip.
Encode refusal stays `invalid_value`. Decode failure stays `codec`.
The adapters for Keyv and cache-manager map the tagged result to their own API.

Source: [#12 comment, 2026-11-10 03:20 UTC](https://github.com/inkcasthq/kvpg/issues/12#issuecomment-6758118547).
Where: standard.md S1, S7 and Values, spec-1.0.md R06 and R12.

### OD5. OpenTelemetry versions (#14)

Decision: kvpg 1.0 supports OpenTelemetry API 1.9 and later with SDK 2.
If the logs package is present, logs go through it.
A test operates kvpg with each supported pair, with no provider and with the instance off switch.
A test starts the SDK after kvpg.

Source: [#14 comment, 2026-11-10 03:20 UTC](https://github.com/inkcasthq/kvpg/issues/14#issuecomment-6758118829).
Where: telemetry.md T01 and T02. RF14 and RF15 give the package form.

### OD6. Limits and cancellation (#16)

Decision: size and batch limits are finite and configurable for each store.
Each limit has its own error code, with a test at the limit and one item over it.
The defaults follow the measurements of #7.
Release 1.0 has no abort interface. A committed write stays authoritative.

Source: [#16 comment, 2026-11-10 03:28 UTC](https://github.com/inkcasthq/kvpg/issues/16#issuecomment-6758154481).
Where: standard.md S14, spec-1.0.md R16. RF6 gives the limits and their provisional defaults.

### OD7. Adapter qualification (#17)

Decision: release 1.0 qualifies Keyv 5, Keyv 6 and cache-manager 7, each one separately.
The postgres.js adapter (#5) is in 1.0.

Source: [#17 comment, 2026-11-10 03:28 UTC](https://github.com/inkcasthq/kvpg/issues/17#issuecomment-6758154749).
Where: spec-1.0.md R14.

### OD8. Native telemetry and one telemetry contract (#6, 2026-11-08)

Decision: telemetry is native to the main package, not a plugin.
`docs/telemetry.md` is the one telemetry contract for every store and adapter.
The package depends on the OpenTelemetry API only. The application owns the SDK, the exporters and the sampler.

Source: issue #6 body, decisions of 2026-11-08 and 2026-11-08 23:00 UTC.
Where: telemetry.md T01 to T13.

### OD9. First build batch and RED metrics (owner, 2026-11-10 03:32-03:34 UTC)

Decision: the first batch also builds the PostgreSQL store of #2 and the conformance suite of #3, on PostgreSQL 15 to 18.
Each store operation emits its span and the full RED metrics from day 1: a call count by operation and outcome, an error count by `KvError` code, and a duration histogram.
The batch writes no adapter code.

Source: the owner instruction to the build job, 2026-11-10 03:32-03:34 UTC.
Where: telemetry.md T09 (RF13), `docs/build-plan.md`.

## Refinements

### RF1. `getMany` returns tagged results

Decision: `getMany` returns one `ReadResult` for each requested key, in input order.
Reason: OD4 removes the ambiguity of `undefined` for `get`. `getMany` has the same ambiguity, so it uses the same result type.
Source: OD4, standard.md S7.

### RF2. `setMany` returns one outcome for each entry

Decision: `setMany` returns `WriteOutcome[]`, one `'written'` or `'exists'` for each entry, in input order.
An entry without `ifAbsent` always gives `'written'`. One batch can mix entries with and without `ifAbsent`.
`set` keeps its boolean result (S2, S6).
Reason: OD3 asks for one result for each entry. One result type for every batch keeps the API simple.
Source: OD3.

### RF3. `setMany` is one SQL statement

Decision: `setMany` writes all entries with one `INSERT ... SELECT FROM unnest(...) ... ON CONFLICT` statement.
The `ifAbsent` condition of each entry is part of that statement.
A plain `Queryable` is then enough for `setMany`. `TransactionalQueryable` stays in the extension types for later capabilities that need a fixed connection (R21).
Reason: PostgreSQL runs one statement atomically, so all entries commit or none do (S7).
One statement needs no connection checkout, so a `pg` Client works for every operation.
Source: PostgreSQL documents, `INSERT` (`ON CONFLICT DO UPDATE ... WHERE`). The conformance suite proves the rollback with a statement that fails on one row.

### RF4. Repeated keys in other batches

Decision: only `setMany` refuses a repeated key (OD3).
`getMany` and `deleteMany` keep S7: a repeated read key gets the same result each time, and `deleteMany` counts a deleted live entry once.
Reason: OD3 names batch writes. A repeated read or delete has one clear result. A refusal there only breaks callers.
Source: OD3, standard.md S7.

### RF5. Error codes

Decision: `KvErrorCode` is `invalid_key`, `invalid_ttl`, `invalid_value`, `invalid_batch`, `value_too_large`, `batch_too_large`, `codec`, `driver`, `schema` and `closed`.
`invalid_batch` covers a repeated key in a batch write (OD3) and a batch argument that is not a list or not a valid cleanup option.
`value_too_large` and `batch_too_large` are the codes of the two limits of RF6 (OD6).
`schema` means that `migrate()` found a table that does not match the store configuration (R04).
Reason: OD3 and OD6 name new failures. Each failure keeps one code, so a caller can act on it without parsing a message.
Source: OD3, OD6, spec-1.0.md R04.

### RF6. The two limits and their provisional defaults

Decision: each store has `limits: { maxValueBytes, maxBatchSize }`.
`maxValueBytes` bounds the encoded size of one value, in bytes. Over it, the write rejects with `value_too_large`.
`maxBatchSize` bounds the entries of `getMany`, `setMany` and `deleteMany`, and the `batchSize` of `cleanupExpired`. Over it, the call rejects with `batch_too_large`.
The provisional defaults are 1,048,576 bytes and 5,000 entries. #7 measures the cost at each limit, and a default changes only after that measurement.
A limit must be a positive safe integer. `createStore` refuses any other value with a `RangeError`.
Reason: #16 names "encoded value size and batch size". One batch limit for all batches keeps the S10 cleanup default (5,000) valid.
Source: OD6, #16 body, standard.md S10.

### RF7. Keys must be well-formed strings

Decision: a key that holds a lone UTF-16 surrogate rejects with `invalid_key`.
The namespace follows the same rules, but it can be empty. `createStore` refuses an invalid namespace with a `RangeError`.
Reason: UTF-8 encoding turns a lone surrogate into U+FFFD. Two different caller strings can then become one stored key.
Source: spec-1.0.md R05 (the recommendation of #2). `String.prototype.isWellFormed` (ECMAScript 2024) makes the check exact.

### RF8. Namespace framing

Decision: the stored key is `<UTF-8 byte length of the namespace>:<namespace><key>`, also for the empty namespace (`0:<key>`).
Reason: plain concatenation lets namespace `a` with key `bc` and namespace `ab` with key `c` collide. The length frame makes each namespace a distinct key prefix.
Source: spec-1.0.md R05.

### RF9. `deletePrefix` uses a key range

Decision: `deletePrefix` deletes `key >= $1 AND key < $2`.
`$1` is the framed prefix. `$2` replaces the last code point of `$1` with the next code point, after the surrogate range, with a carry over U+10FFFF.
The framed prefix starts with an ASCII digit, so an upper bound always exists.
Reason: with `COLLATE "C"`, PostgreSQL compares keys by their UTF-8 bytes, and UTF-8 keeps the code point order.
Each string that starts with `$1` is then in the range, and no other string is.
A measurement on PostgreSQL 15.19, 16.15, 17.11 and 18.6 showed that the range form uses the primary key index also in a generic plan.
`starts_with(key, $1)` falls back to a sequential scan in a generic plan, which postgres.js uses for its named prepared statements.
Source: `bench/prefix-plan.mjs` and its output in `bench/results/prefix-plan-2026-11-10.jsonl`.

### RF10. `deletePrefix` counts live entries

Decision: `deletePrefix` returns the count of live entries that it deleted. It can also delete expired entries with the prefix, and these do not count.
Reason: the same rule as `delete` (S5) and `deleteMany` (S7).
Source: spec-1.0.md R09.

### RF11. Configuration errors at construction

Decision: `createStore` throws a `TypeError` or a `RangeError` for invalid configuration. Store operations reject only with `KvError`.
Reason: a configuration error is a programming error at startup. S12 governs operations.
Source: standard.md S12.

### RF12. "Provider registered" and "no-op" in testable terms

Decision: for each signal and each operation, the store asks the OpenTelemetry API whether a provider is registered.
- Traces: the global tracer provider is a `ProxyTracerProvider` with no delegate tracer (`getDelegateTracer` returns `undefined`).
- Metrics: the global meter provider returns the no-op meter (`createNoopMeter()`).
- Logs: the logger of the logs package reports `enabled()` as false.
If no signal has a provider and no hook is set, the operation reads no clock, builds no attribute object and calls no recording method.
The environment switch `OTEL_NODEJS_INSTRUMENTATION_KVPG_ENABLED` and the instance switch stay. Each one can only turn telemetry off for its scope.
Reason: OD2 needs a rule that a test can check. Each check uses a public API of the qualified packages. The no-op tracer can return a valid span context from a parent, so "create a span and test its context" alone is not a no-op.
Source: `@opentelemetry/api` 1.9.1 `build/src/trace/ProxyTracerProvider.js`, `build/src/api/metrics.js:35-36`, `build/src/metrics/NoopMeterProvider.js`. `@opentelemetry/api-logs` 0.223.1 `build/src/ProxyLogger.js` (`enabled`) and `NoopLogger.js`.

### RF13. RED metrics

Decision: two counters join the histogram of T09.
`kvpg.operation.calls` (unit `{call}`) counts each completed operation, with operation, store, trigger and outcome.
`kvpg.operation.errors` (unit `{error}`) counts each failed operation, with operation, store, trigger and `error.type`.
Reason: OD9 names a call count, an error count by code and a duration histogram.
The histogram count gives the same numbers. The conformance suite proves that the counters and the histogram count agree.
Source: OD9.

### RF14. The API is a peer dependency

Decision: the main package declares `@opentelemetry/api` `^1.9.0` as a peer dependency and `@opentelemetry/api-logs` as an optional peer dependency. It has no other runtime dependency.
Reason: the API accepts a registered global only from an equal or lower minor version.
A nested copy of API 1.10 inside kvpg then sees the SDK 2 global of the application as incompatible, and records nothing.
A peer dependency shares the one copy of the application. OpenTelemetry instrumentation packages also declare the API as a peer.
Source: `@opentelemetry/api` 1.9.1 `build/src/internal/semver.js` (`ownVersionParsed.minor <= globalVersionParsed.minor`). `npm view @opentelemetry/instrumentation-pg@0.76.0 peerDependencies` gives `{"@opentelemetry/api":"^1.3.0"}`.

### RF15. The logs path

Decision: at package load, the store imports `@opentelemetry/api-logs` once.
If that package is not installed, logs are off and the other signals work.
Any other import error fails the import, so a broken installation is visible.
Reason: OD5 says: if the logs package is present, logs go through it. API 1.10 has logs inside `@opentelemetry/api`, but SDK 2 needs API 1.9. The API 1.10 path is a #14 qualification task.
Source: OD5, `npm view @opentelemetry/sdk-metrics@2.12.1 peerDependencies` gives `{"@opentelemetry/api":">=1.9.0 <1.10.0"}`. The other SDK 2 packages accept a wider range, for example `sdk-trace-base` 2.12.1 accepts `>=1.3.0 <1.10.0` (read from the installed `package.json`).

### RF16. Histogram buckets

Decision: `kvpg.operation.duration` gives the advice `explicitBucketBoundaries` `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]` seconds.
Reason: the SDK default boundaries suit milliseconds, not seconds. These are the boundaries that the semantic conventions advise for `db.client.operation.duration`.
Source: OpenTelemetry semantic conventions 1.45.0, database metrics.

### RF17. The PostgreSQL driver

Decision: the store needs no driver package at runtime. It takes any `Queryable`.
The qualified driver of 1.0 is `pg` (node-postgres) 8. The tests and the examples use it. postgres.js follows through the adapter of #5.
Reason: a `pg` Pool and a `pg` Client already have the `Queryable` shape (extension.ts). `pg` sends each query as an unnamed statement, so PostgreSQL plans it with the parameter values.
Source: `packages/kvpg/src/extension.ts:5`, issue #5 ("A pg Pool fits both and a pg Client fits Queryable only").

### RF18. The default codec

Decision: the default codec is `json`. It stores UTF-8 JSON text in a `bytea` column.
It accepts the JSON data model: `null`, booleans, strings, finite numbers, arrays and plain objects, nested at any depth.
It refuses `undefined`, functions, symbols, BigInt, cycles, non-finite numbers, sparse arrays and objects that are not plain, with `invalid_value`.
A round trip keeps JSON equality: object key order does not count, and `-0` becomes `0`.
A custom codec can accept other values, also `undefined`. The tagged read result returns them as `{ found: true, value }`.
Reason: OD4 asks for each permitted round trip. A refusal is safer than a silent change of the value.
Source: OD4, spec-1.0.md R02 (the recommendation of #12).

### RF19. `migrate()` checks the table

Decision: after `CREATE TABLE IF NOT EXISTS`, `migrate()` reads the catalog. If the `key`, `value` or `expires_at` column has a different type or collation, `migrate()` rejects with `schema`.
Reason: an existing table must not change silently (R04).
Source: spec-1.0.md R04.

### RF20. Contract payloads for the capabilities come with their phase

Decision: `contracts/` holds the schemas of the store operations and of the telemetry in this batch.
Each capability of R17 to R22 adds its own schemas, samples and types in its build phase, before its code.
The gate test and the drift test read every file in `contracts/`, so a new capability is checked without a test change.
Reason: the capability sections fix the rules now. The payloads of a capability are best written with its types, in the phase that builds it.
Source: OD1, `docs/build-plan.md`.

### RF21. Development dependencies

Decision: the workspace adds these exact-version development dependencies. The published package gets none of them as a runtime dependency.

| Package | Version | Use |
| --- | --- | --- |
| `ajv` | 8.20.0 | The contract gate test reads the JSON Schema 2020-12 files of `contracts/`. |
| `pg` | 8.23.1 | The store tests and the examples (RF17). |
| `@opentelemetry/api` | 1.9.1 | The test copy of the peer dependency (RF14). |
| `@opentelemetry/api-logs` | 0.223.1 | The logs path of the tests (RF15). |
| `@opentelemetry/sdk-trace-base` | 2.12.1 | The in-memory span exporter of `test/telemetry/`. |
| `@opentelemetry/sdk-metrics` | 2.12.1 | The in-memory metric exporter of `test/telemetry/`. |
| `@opentelemetry/sdk-logs` | 0.223.1 | The in-memory log exporter of `test/telemetry/`. |
| `@opentelemetry/resources` | 2.12.1 | The test resource. |
| `@opentelemetry/context-async-hooks` | 2.12.1 | The test context manager. |
| `@opentelemetry/core` | 2.12.1 | The test propagator. |

Reason: OD5 selects the SDK 2 generation, and the telemetry tests of `test/telemetry/` need one SDK of that generation. The lockfile adds 19 transitive packages of these 10 and removes none.
Source: OD5, `package.json`, `package-lock.json`.
