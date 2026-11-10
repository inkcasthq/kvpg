# Build plan of release 1.0

This plan orders the build of release 1.0 (epic #1) in phases.
`docs/spec-1.0.md` gives the rules of each phase, and `docs/decisions.md` gives the decisions.
Each phase is one branch and one review. It starts from the contract: its schemas, samples and types come first, then its code (RF20).
If its proof command gives 0 failures and 0 pending cases, a phase is done. Each phase adds its result to `CHANGELOG.md`.

The test databases are PostgreSQL 15, 16, 17 and 18. Each proof command reads them from `KVPG_TEST_DATABASE_URLS`:

```sh
KVPG_TEST_DATABASE_URLS=postgres://USER:PASSWORD@HOST:5415/kvpg,postgres://USER:PASSWORD@HOST:5416/kvpg,postgres://USER:PASSWORD@HOST:5417/kvpg,postgres://USER:PASSWORD@HOST:5418/kvpg npm test
npm run check
```

Two issues have no build phase:
- Spike #9, "Research comparable cache libraries and native telemetry", is closed. Its findings are in the issue and in the issues that it filed.
- Issue #10, "Settle the contract and qualification work found by spike #9", lists the contract decisions. `docs/decisions.md` records the owner decisions on them, and the phases below build them.

## Status

| Phase | Issues | Status |
| --- | --- | --- |
| 1. Design and owner decisions | #1, #6, #11, #12, #14, #15 to #22 | Done in batch 1 |
| 2. Contract payloads | #2, #3, #11, #12, #13, #16 | Done in batch 1 |
| 3. PostgreSQL store and conformance suite | #2, #3, #6 (spans and RED metrics), #11, #12, #13, #16 | Done in batch 1 |
| 4. postgres.js adapter | #5 | To do |
| 5. Telemetry: driver spans, Prometheus, cost | #6 | To do |
| 6. Supported API and SDK pairs | #14 | To do |
| 7. Measured table choices | #7 | To do |
| 8. Keyv and cache-manager | #4, #17 | To do |
| 9. Cache loader | #15 | To do |
| 10. Namespace clear and tags | #18 | To do |
| 11. Compression and encryption codecs | #19 | To do |
| 12. Counters and compare-and-set | #20 | To do |
| 13. Locks and a memory tier | #21 | To do |
| 14. Capacity rules | #22 | To do |
| 15. Release | #8 | To do |

## Batch 1: phases 1 to 3 (done)

- Phase 1 (commit `0932be2`): the owner decisions OD1 to OD9 and the refinements in `docs/decisions.md`. The R02 rows of the spec are decided. Contract version 1 is in `docs/standard.md`.
- Phase 2 (commit `7ef068e`): `contracts/` with one schema for each operation and each signal, valid and invalid samples, the gate test and the drift test.
- Phase 3 (commit `9bf22b9`): the store of #2 (`createStore`) and the suite of #3 (`@inkcasthq/kvpg-conformance`). Telemetry gives spans and the RED metrics through the OpenTelemetry API only.

The proof of phase 3, on PostgreSQL 15.19, 16.15, 17.11 and 18.6: `npm test` gives 782 tests, 768 pass, 0 fail and 14 skipped.
Each skipped case names the phase that removes it:

| Pending case | Count | Phase |
| --- | --- | --- |
| T05 database CLIENT spans have exactly one external owner | 4 | 5 |
| T05 driver retry attempts share one kvpg parent and one operation duration | 4 | 5 |
| T04/T07 adapter delegation adds no second kvpg span, metric, or log | 4 | 8 |
| T11 Prometheus scrape and OTLP routes | 2 | 5 |

Two parts of batch 1 are not operated:
- The `pg_cron` policy. `schemaSql()` gives the schedule, and the test runs its command directly. No test database has the extension (RF28).
- The CI job `test` in `.github/workflows/ci.yml`. It is written, but no push ran it.

## Phase 4. postgres.js adapter (#5)

- Rules: R14 (`fromPostgresJs(sql)` returns a `TransactionalQueryable`), OD7, RF17.
- Contract first: the type of `fromPostgresJs` in `packages/kvpg/src/extension.ts`, and its drift pair.
- Files: `packages/kvpg/src/postgres-js.ts`, `test/store/postgres-js.test.mjs`. A dev dependency on `postgres` at an exact version, named in `docs/decisions.md`.
- Tests: the portable suite on PostgreSQL 15 to 18 through the adapter. A transaction that fails and releases its connection. A named statement that keeps the primary key in a generic plan (the R09 case of `test/store/postgresql.test.mjs` already measures the generic plan).
- Proof: the proof command, with the adapter subjects in the output for each version.
- Done when: the suite passes through the adapter on the four versions, and the adapter adds no runtime dependency to `@inkcasthq/kvpg`.

## Phase 5. Telemetry: driver spans, Prometheus, cost (#6)

- Rules: T05, T11 and T12 of `docs/telemetry.md`, RF12 to RF16.
- Files: `test/telemetry/postgres-fixture.mjs` (`driverInstrumentation: true` and `driverScope`), `test/telemetry/postgres-telemetry.mjs` (remove the `driverInstrumentation` entry of `PENDING`), the integration factories of `test/telemetry/prometheus-scrape.test.mjs` and `prometheus-otlp.test.mjs`, `bench/telemetry-cost.mjs`.
- Dependencies: `@opentelemetry/instrumentation-pg` of the SDK 2 generation and the Prometheus exporter and OTLP exporter of the same generation, as dev dependencies at exact versions. A Prometheus binary on loopback for the T11 routes.
- Tests: the two T05 cases on PostgreSQL 15 to 18 and the two T11 routes.
- Cost: the four T12 modes `off`, `api-only`, `sdk-ratio` and `sdk-always`.
- Proof: the proof command with 0 pending T05 and T11 cases. `node bench/telemetry-cost.mjs` writes its raw output to `bench/results/`.
- Done when: the CLIENT span has one owner, and each route counts one cache hit once.

## Phase 6. Supported API and SDK pairs (#14)

- Rules: OD5 (API 1.9 and later with SDK 2), T01, RF14, RF15, RF25.
- Files: `test/telemetry/pairs/` with one install for each pair, and a script that runs the telemetry suite in each one.
- Tests: the lowest and the latest API 1.x with the lowest and the latest SDK 2.x. A run without `@opentelemetry/api-logs` (logs off, the other signals on). A run with the oldest `api-logs` of the peer range, to measure RF25.
- Proof: the pair script gives 0 failures for each pair, and its output lists the versions.
- Done when: `docs/telemetry.md` T02 lists only measured pairs.

## Phase 7. Measured table choices (#7)

- Rules: R23 and the D1 choice of `docs/design.md`.
- Files: `bench/table-choices.mjs`, `bench/results/`, `docs/benchmarks.md`.
- Tests: an expiry index or none at 100,000 and 10,000,000 rows, with HOT share and cleanup time for each batch. Logged and unlogged tables. `bytea` and `jsonb` at one and eight clients. Batch and value sizes at the S14 limits.
- Proof: the benchmark command and its raw output, with the machine, the versions and the commands.
- Done when: `docs/design.md` links each table choice to a measured result. A default changes only after the result and an owner decision.

## Phase 8. Keyv and cache-manager (#4, #17)

- Rules: R14, OD4, OD7.
- Contract first: the mapping of a tagged read to the missing value of each interface, as types of the new package.
- Files: `packages/kvpg-keyv/` (`@inkcasthq/kvpg-keyv`), one test file for each interface, and `createAdapter()` in the telemetry fixture.
- Tests: Keyv 5, Keyv 6 and cache-manager 7, each in its own install, and a NestJS `CacheModule` for each one. A value round trip, expiry, a missing read, an error, cleanup of the resources of the adapter, and the clock skew of an absolute expiry. The T04/T07 adapter case of the telemetry suite.
- Proof: the proof command with 0 pending adapter cases, and the result of each interface.
- Done when: each interface passes its own run, and the package advertises only the capabilities of that interface.

## Phase 9. Cache loader (#15)

- Rules: R17 (`createLoader(store)`, one load for each key and loader, the code `loader`, no abort under OD6).
- Contract first: the schemas and samples of `load` and its result `{ value, source }`, and the new error code in `KV_ERROR_CODES`.
- Files: `packages/kvpg/src/loader.ts`, `packages/kvpg-conformance/src/loader.mjs` (an optional suite), `test/store/loader.test.mjs`.
- Tests: concurrent loads of one key, and a failed load with a later load. A write or a delete during a load. `freshMs` and a stale value. Close during a load.
- Proof: the proof command. The new code passes the drift test.
- Done when: the loader suite passes on the PostgreSQL store and on the reference store.

## Phase 10. Namespace clear and tags (#18)

- Rules: R18 (`clearNamespace()`, a tags table with cascade, `deleteTag(tag)`, the codes `invalid_tag` and `too_many_tags`, tags are private data under S13).
- Contract first: the schemas, the types and the two codes.
- Files: `packages/kvpg/src/tags.ts`, the DDL of the tags table in `sql.ts`, `test/store/tags.test.mjs`, an optional suite.
- Tests: an empty namespace that is refused, a tag on many keys, and a delete of a tag. The cascade after an entry expires or goes. The privacy of tags in each signal.
- Proof: the proof command, and the privacy assertions of `test/telemetry/` with a tag marker.
- Done when: no signal and no hook holds a tag.

## Phase 11. Compression and encryption codecs (#19)

- Rules: R19. An envelope has a magic number, a version and a kind. Gzip and brotli have `maxDecodedBytes`. AES-256-GCM has key IDs and rotation. Each bad input gives `codec`.
- Contract first: the codec types and the envelope format in `contracts/`.
- Files: `packages/kvpg/src/codecs/`, `test/store/codecs.test.mjs`.
- Tests: a round trip of each codec and a key rotation. The negative tests of R19: a truncated envelope, a wrong marker, an unknown version and changed ciphertext. Also an unknown key ID and a value over `maxDecodedBytes`.
- Proof: the proof command.
- Done when: each bad input gives `codec` with its cause, and no key material is in a signal.

## Phase 12. Counters and compare-and-set (#20)

- Rules: R20 (`increment` on the json codec, the codes `not_a_counter` and `counter_overflow`, `compareAndSet` with the outcomes `written` and `mismatch`).
- Contract first: the schemas, the types and the two codes.
- Files: `packages/kvpg/src/store.ts` (two operations), `sql.ts`, an optional suite.
- Tests: concurrent increments and a race of two compare-and-set calls. The negative tests of R20: a counter over a text value, a delta of 0.5, an overflow and a mismatch. The recovery tests: a counter after its key expired, and a compare-and-set after a mismatch with a fresh read.
- Proof: the proof command, with the optional suite on the PostgreSQL store and the reference store.
- Done when: the two operations have spans and RED metrics like the other operations.

## Phase 13. Locks and a memory tier (#21)

- Rules: R21. Table leases have a token and a fence, with release and renewal rules, and no session advisory locks. A memory tier listens on a held connection. A lost listener clears the tier.
- Contract first: the lease types and their schemas.
- Files: `packages/kvpg/src/locks.ts`, `packages/kvpg/src/tier.ts`, `test/store/locks.test.mjs`, `test/store/tier.test.mjs`.
- Tests: two holders of one lease, a renewal after expiry, and a release with a wrong token. A fence that refuses an old holder. A lost listener connection.
- Proof: the proof command, with a lifecycle review of restart and recovery.
- Done when: no path depends on a session lock, and a lost listener clears the tier.

## Phase 14. Capacity rules (#22)

- Rules: R22 (eviction never removes a persistent entry, a batch across shards gives `invalid_batch`, expiry partitions are refused).
- Files: `packages/kvpg/src/capacity.ts`, `test/store/capacity.test.mjs`, the measurements of phase 7.
- Tests: the negative tests of R22, a cross-shard batch and a persistent entry over the capacity. The recovery tests: eviction after a failed eviction run, and a batch after a cross-shard refusal. A table partitioned by expiry that is refused.
- Proof: the proof command and the benchmark output of the capacity options.
- Done when: each rule of R22 has a test, and each default has a measured result.

## Phase 15. Release (#8)

- Rules: R23 (npm trusted publishing on a tag, provenance, version 1.0.0, no npm credential in the repository).
- Files: `.github/workflows/release.yml`, the package manifests (`private` removed and the version set), `docs/release.md`.
- Owner actions: the npm organization and the trusted publisher entries.
- Proof: a release candidate tag in a test repository, then the provenance of each package.
- Done when: phases 4 to 14 are done, and the release evidence names the source SHA, the matrix, the commands and the full test counts.
