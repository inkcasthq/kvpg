# kvpg 1.0 combined specification

This draft combines behavior, implementation logic, and release acceptance for epic #1.
It describes the target release, not the current implementation.
Baseline `ba7f1c1` contains types and design documents, without a store.
The owner issue decisions take precedence over this draft.
The existing cache contract remains the authority for S1 through S12.

`MUST` states a requirement. `SHOULD` states a recommendation with a documented reason for each deviation.
The telemetry contract is `docs/telemetry.md`, T01 through T13.
This document incorporates that contract without creating a second telemetry definition.
Each normative paragraph cites an issue, a baseline file location, or the telemetry contract.
Detailed logic under an issue is a design proposal unless this document identifies an existing rule.

## R01. Release scope

Release 1.0 MUST include the PostgreSQL store, portable conformance suite, Keyv adapter, postgres.js adapter, native telemetry, measured table choices, and release provenance. [I1]
The main package exports the contract, extension interfaces, `KvError`, and `createStore`.
The planned additional packages are `@inkcasthq/kvpg-conformance` and `@inkcasthq/kvpg-keyv`.
Each store and adapter MUST obey S1 through S12 and the telemetry contract. [I1], [I3], [I6]
The release MUST retain Apache-2.0 licensing and the existing notices. [LICENSE]
No server or new network protocol belongs to this release.

The build MUST pass on Node.js 22, 24, and 26. [I2]
The PostgreSQL store and postgres.js adapter MUST pass conformance on PostgreSQL 15, 16, 17, and 18. [I2], [I5]
PostgreSQL qualification uses real databases, not driver stubs alone.

## R02. Owner decisions before implementation

An open choice does not become an accepted rule through a recommendation.
The build MUST record the owner decisions for #11 and #12 before implementing their affected contract behavior. [I10], [I11], [I12]
The release MUST record #14 before claiming an OpenTelemetry compatibility range. [I14]
The table names each known owner choice and its recommendation.

| Choice | Options | Recommendation | Acceptance after selection |
|---|---|---|---|
| OPEN #6: telemetry default | Enabled, or disabled | Enable native signals by default | Operate both explicit switches and the selected implicit default |
| OPEN #11a: conditional batches | Exclude conditional writes, reject the complete batch on conflict, or return per-entry outcomes | Exclude `ifAbsent` from batch writes in 1.0 | Reject unsupported conditional input before SQL, or prove the selected atomic conflict rule |
| OPEN #11b: repeated batch keys | Reject duplicates, choose the last occurrence, or define per-entry ordered execution | Last occurrence wins after every entry passes input and codec processing | Prove the final value and expiry, with rollback after an unrelated error |
| OPEN #12: missing result | Reserve `undefined`, or introduce tagged reads | Reserve `undefined` to retain current read types | Refuse stored `undefined` with `invalid_value` and decoded `undefined` with `codec` |
| OPEN #14: API/SDK generation | API 1.10 with SDK 3, or an older generation with an application logs bridge | Qualify API 1.10 with SDK 3 first | Operate exact supported pairs, absent providers, late providers, and instance off |
| OPEN #16: size and batch bounds | Fixed release limits, configurable finite limits, or explicit unbounded defaults | Finite configurable limits after #7 measures boundary costs | State each limit and error code, then operate the boundary and one item over it |
| OPEN #16: cancellation | No abort interface in 1.0, or an explicit abort contract | Defer an abort interface and keep committed writes authoritative | Document the lack of abort support, or prove before-dispatch and after-commit outcomes |
| OPEN #17: adapter qualification horizon | Keep Keyv qualification in 1.0, or defer it by owner decision | Retain 1.0 and qualify Keyv 5, Keyv 6, and cache-manager 7 separately | State supported majors and operate each supported integration |
| OPEN #7: measured table defaults | Retain or change D1, D5, and D6 after measurement | Retain draft defaults until data supports a change | Publish raw measurements and update the design rationale |
| OPEN #15 and #18 through #22: horizon | Keep after 1.0, or explicitly extend scope | Keep after 1.0 | An added feature needs its own contract and negative and recovery tests |

For #11a, exclusion also needs a runtime refusal code for untyped callers.
Recommendation: use `invalid_value` for an unsupported conditional batch entry.
For #11b, the last occurrence includes its value and expiry configuration.
All entries still pass input processing, including an earlier duplicate that does not survive reduction.
These recommendations do not alter the current `Entry.options?: SetOptions` type yet.

For #12, a custom codec declares its supported value domain and round-trip equality.
Recommendation: retain JSON data-model equality for the default codec.
Objects compare without property order, and numeric equality treats negative zero as zero.
Top-level and nested unsupported values fail rather than silently disappear.

## R03. Store facade and driver logic

The proposed call is `createStore({ db, codec, hooks, cleanup, table, namespace, defaultTtlMs, telemetry })`.
Only `db` is required.
The store MUST accept `Queryable`, with `TransactionalQueryable` for nonempty `setMany`. [I2], [EXT]

The facade exposes `KvStore` plus `schemaSql()` and `migrate()`.
The current contract types define each portable operation result. [API]
`schemaSql()` returns DDL text without a database call.

`migrate()` applies that DDL through the driver.
Construction does not silently migrate a database.

The logic of each asynchronous operation follows this sequence:

1. Start enabled telemetry under the caller context.
2. Refuse a closed store before database work.
3. Process every input and encode required values.
4. Do the database work with parameters.
5. Decode required results.
6. Finish telemetry with a safe outcome.
7. Deliver the safe operation hook.
8. Return the result or reject with `KvError`.

If observers fail, the sequence MUST preserve the operation result. [S12], [HOOK], [TEL]
Input refusal and empty batches still receive telemetry under T04.
The database result shape is `{ rows, rowCount }`.

The store MUST interpret a nullable `rowCount` through a documented query result rather than assume that null means success. [EXT], [I2]
The driver MUST release an acquired transaction connection on every success and error path. [I2], [EXT]
A rollback error does not replace the first caller error.

The caller receives that first error as the `cause` of the safe contract error.
Internal SQL is fixed apart from quoted identifiers and bounded statement structure.

Acceptance operates a Pool, a Client for single statements, a transaction-capable adapter, and a driver that rejects.
A nonempty batch with no transaction connection rejects with `driver` before its first write.
An empty batch succeeds without requiring a transaction connection.
A connection failure, statement failure, rollback failure, and subsequent success each have a deterministic test.

## R04. Table and schema

The baseline DDL is:

```sql
CREATE TABLE IF NOT EXISTS public.kvpg_entries (
  key text COLLATE "C" PRIMARY KEY,
  value bytea NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT 'infinity'
) WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.01);
```

The store MUST produce this structure with the selected schema, table, codec column, and table configuration. [I2], [DDL]
The default schema is `public`, and the default table is `kvpg_entries`.
`unlogged` defaults to false.

The codec selects `bytea`, `text`, or `jsonb` at creation.
An existing table does not change codec column types automatically.
The default codec stores JSON data in `bytea`, subject to the #12 decision.

The table has no index on `expires_at` until #7 changes D1 from measurement.

Schema and table names MUST be quoted as PostgreSQL identifiers, including embedded quotes. [I2]
Keys and values MUST use query parameters. [I2]
An identifier MUST NOT become executable SQL through string concatenation without identifier quoting. [I2]
`schemaSql()` and `migrate()` MUST describe and apply the same table. [I2], [DDL]
Migration is explicit and repeatable through `CREATE TABLE IF NOT EXISTS`.
An incompatible existing schema fails visibly through `KvError` rather than changing application data silently.

Acceptance compares the generated DDL with the selected configuration and the catalog of a migrated database.
It operates migration twice and stores a value afterward.
It uses identifiers with quotes and the key `'); DROP TABLE x; --` as ordinary data.
It proves that no additional statement executes.
It measures logged and unlogged modes without promising durability for an unlogged table.

## R05. Keys and namespaces

A key is the string supplied by the caller.
An internal key also identifies the namespace.
The store MUST accept keys of 1 through 1,024 UTF-8 bytes without NUL and compare them byte by byte. [S3]

It MUST reject other keys with `invalid_key`. [S3]
The store does not normalize Unicode or change case.
Recommendation for issue #2: reject malformed UTF-16 strings instead of allowing replacement characters to merge distinct caller strings.

That refinement requires an explicit contract update and positive and negative tests before adoption.

The store MUST isolate namespaces for reads, writes, prefix deletion, and cleanup. [NS]
Simple raw concatenation is insufficient for overlapping namespace strings.
Proposed internal framing is `byteLength(namespace) + ':' + namespace + key`.

The length uses UTF-8 bytes and a canonical decimal representation.
For example, namespaces `a` and `ab` then have different internal prefixes.
The 1,024-byte key limit applies before this internal framing.

Every query includes the namespace boundary, including cleanup queries.

Acceptance covers empty keys, NUL, multibyte boundaries, a 1,024-byte key, and a 1,025-byte key.
It covers case differences, composed and decomposed Unicode, and keys that contain SQL syntax.
It uses namespaces `a`, `ab`, and the empty namespace with keys that collide under raw concatenation.
It proves isolation after prefix deletion and concurrent cleanup.

## R06. Expiry and reads: S1, S4, S9

A live entry has no expiry or an expiry after the store time.
An expired entry has an expiry at or before that time.
For PostgreSQL, the store time is database `now()`.
`now()` uses the start of its transaction.
Client clock skew does not change relative expiry.

The store MUST treat expired entries as missing for `get`, `getMany`, `has`, and `ttl`, even before cleanup. [S1]
`get` returns the decoded live value or the missing result selected by #12.
`has` returns a boolean without changing expiry.
`ttl` returns `{ state: 'missing' }`, `{ state: 'persistent' }`, or `{ state: 'expiring', ms }`.
For an expiring live entry, `ms` is nonnegative remaining milliseconds, rounded down.
An entry with less than one millisecond left can return zero while it remains live.

`ttlMs` MUST be a positive safe integer, and `expiresAt` MUST be a valid `Date`. [S4]
Giving both MUST reject with `invalid_ttl`. [S4]
Zero, negative, fractional, unsafe, and nonfinite `ttlMs` inputs MUST reject with `invalid_ttl`. [S4]

A past absolute date makes the written entry expired immediately.
With neither expiry field, the store uses its default lifetime or persistence.
`expire` uses the same expiry validation and changes only a live entry.

`persist` removes the expiry only from a live entry.
These methods MUST return false for missing or expired entries. [S9]
An expired entry does not become live through `expire` or `persist`.

The SQL MUST decide liveness and relative expiry from the database clock. [CLOCK], [S1], [S4]
Reads use `expires_at > now()`.
Persistent entries use PostgreSQL `infinity` and pass that predicate.
`ttl` distinguishes infinity before subtracting timestamps.
No read refreshes expiry implicitly.

Acceptance covers expiry equality, past dates, persistence, default expiry, and an explicit absolute deadline.
It changes the application clock while the database clock stays fixed.
It proves that expired rows remain invisible while they still exist physically.

It covers `NaN`, infinity, unsafe integers, invalid dates, both expiry fields, and values just inside the accepted integer range.
Database range errors preserve S12 and cannot produce a silent persistent entry.
Total wall-clock sleeps in portable expiry tests MUST stay at or under two seconds. [I3]

The PostgreSQL tests use controlled transactions, database timestamps, or expired fixtures instead of long sleeps.

## R07. Writes and deletion: S2, S5, S6

`set` MUST upsert the value and expiry of a live or expired entry. [S2]
Of racing writes, the last write to commit wins.
After a write, `set` returns true.
With `ifAbsent`, it returns false without a change for an existing live entry.
With `ifAbsent`, it MUST replace an expired entry. [S6]
The test MUST prove that two concurrent conditional writes yield one winner for a missing key. [I3]

The proposed PostgreSQL upsert is:

```sql
INSERT INTO public.kvpg_entries AS e (key, value, expires_at)
VALUES ($1, $2, COALESCE($3::timestamptz,
  now() + $4 * interval '1 millisecond', 'infinity'))
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;
-- For ifAbsent, add this condition to the update:
-- WHERE e.expires_at <= now();
```

The implementation substitutes quoted identifiers and supplies all data through parameters.
It does not implement `ifAbsent` as a read followed by a write.
`delete` MUST delete an expired row but return false for it. [S5]
For a deleted live row, it MUST return true. [S5]
For a missing row, it returns false.
The SQL can return `expires_at > now()` from the deleted row.

Acceptance covers replacement of value and expiry, persistence after an expiring value, and the reverse transition.
It uses barriers for racing writes and examines the result after both commits.
It operates conditional conflict, expired replacement, a driver error, and a successful retry by the caller.
The caller retry creates a separate public operation.

## R08. Batches: S7 and open #11

`getMany` MUST return one result per requested occurrence in input order. [S7]
Repeated read keys MUST have the same result within that batch. [S7]
The implementation reads unique keys in one database snapshot, then maps results back to occurrences.
It does not depend on the row order of `ANY($1)`.
A decode error rejects the complete read rather than return partial results.

`setMany` MUST write the complete accepted batch in one transaction or write none. [S7]
The implementation processes all keys, expiry fields, and values before its first write.
It then acquires one connection, begins, writes, commits, and releases.
On a statement error, it rolls back and releases.
The #11 decision defines conditional writes and duplicate reduction before SQL generation.
No statement silently ignores a conditional conflict.

`deleteMany` MUST return the number of live entries deleted, not the number of requested occurrences. [S7]
Repeated delete keys therefore count once.
Every empty batch MUST avoid all database calls, including connection acquisition. [S7]
It still obeys closed-store refusal and enabled telemetry.

Acceptance uses ordered hits and misses, repeated read keys, repeated delete keys, and each empty method.
It injects a failure after one write and proves rollback of every batch entry.
After an error, the next independent batch succeeds on a usable connection.
After owner selection, the suite MUST add positive, negative, concurrent, and recovery tests for both #11 choices. [I11]
Until selection, those policy-specific cases remain unresolved acceptance obligations.

## R09. Prefix deletion: S8

`deletePrefix` MUST compare the caller prefix byte by byte and treat `%`, `_`, and `\\` as literal characters. [S8]
An empty prefix MUST reject with `invalid_key`. [S8]
Its count is the number of live entries removed.
Expired matching rows can also be removed without increasing that count.
The count rule matches `deleteMany` and needs an explicit S8 clarification before the store implementation.
The operation remains inside the framed namespace boundary.

The selected PostgreSQL query MUST use the primary key index. [I2]
OPEN IMPLEMENTATION CHOICE #2: a bytewise range or a proven `starts_with` plan.
Recommendation: use a range only with a correct upper bound over encoded keys.
No naive final-character increment proves correctness for Unicode prefixes.
`LIKE` requires correct escaping and its own indexed-plan proof.

Acceptance covers exact prefix matches, adjacent nonmatches, backslashes, wildcard characters, and multibyte keys.
It proves namespace isolation and the empty-prefix refusal.
It captures `EXPLAIN` output on PostgreSQL 15 through 18 using representative table sizes.
A semantic success without the required plan does not finish #2.

## R10. Cleanup: S10

`cleanupExpired` MUST delete expired entries in batches, with default `batchSize` 5,000 and no default `maxBatches` limit. [S10]
It MUST stop at `maxBatches` or after a batch removes fewer rows than its size. [S10]
The result is `{ deleted, batches }` for confirmed batches, including the final short batch.

Two concurrent cleanups MUST skip locked candidates and never delete the same row twice. [S10], [CLEAN]
Cleanup MUST never delete a live entry or cross its namespace boundary. [S10], [NS]
The baseline query uses `FOR UPDATE SKIP LOCKED` inside the candidate selection and a second expiry predicate in the deletion.

The implementation also applies the namespace predicate.

A short batch can mean that another transaction holds candidate locks.
It does not prove that no expired rows remain globally.
A later invocation retries the remaining work.

`batchSize` bounds deleted rows, not rows scanned or query duration.
Issue #16 governs size limits and cancellation.
Recommendation: accept only positive safe integers for explicit batch limits.

The refusal code remains part of the #16 owner decision because S12 has no dedicated limit code.

Manual cleanup is the default policy.
An interval policy uses a timer that does not keep the process alive.
The interval loop prevents its own overlapping invocations.

The `pg_cron` policy supplies scheduling SQL for an application-managed extension.
It does not claim JavaScript observations for database-only execution.
All policies MUST preserve read behavior under S1. [POLICY], [S1]

Acceptance locks expired candidates in one transaction while another cleanup operates.
After releasing those locks, another invocation removes the remaining expired rows.
It races a renewal with cleanup and proves that the renewed live row survives.
It covers two cleanups, namespace isolation, short batches, maximum batches, partial progress, error, and later recovery.
Confirmed earlier batches can remain committed after a later batch fails.
The call rejects with `KvError`, and telemetry retains only confirmed progress under T09.

## R11. Close and resource ownership: S11

`close` MUST stop every timer owned by the store and leave caller-owned pools and clients open. [S11]
After close begins, new portable operations MUST reject with `closed` before database work. [S11]
Draft lifecycle policy: close first marks the store closed, stops new scheduled work, and waits for accepted work to settle.

It then resolves without stopping application telemetry providers.
An accepted operation can still finish or fail through its normal path.
A second `close` rejects with `closed`, as the current S11 rule states for subsequent calls.

After close, `schemaSql()` also rejects with `closed` under S11.
`migrate()` obeys the same closed-state refusal as database operations.

Acceptance starts work, calls close, and proves that no new work enters the driver.
It releases the accepted work and awaits close.
It makes sure that interval callbacks do not start afterward and that caller queries still succeed.
It covers a failed accepted operation, a second close, and a separate live store on the same pool.

## R12. Values, codecs, and errors: S12 and open #12

A codec converts application values to stored data and back.
Its column type remains fixed for a table.
An encode refusal MUST reject with `invalid_value`. [VALUES]

A decode failure MUST reject with `codec`. [VALUES]
A driver failure MUST reject with `driver`, and a closed operation MUST reject with `closed`. [S12]
Each failure MUST expose one `KvError` with the corresponding code and the original driver or codec cause. [S12]

The store MUST NOT convert an operational failure into a cache miss. [S12]
Cause retention is caller behavior, never permission to publish the cause through telemetry.

OPEN #12 determines missing-result representation and decoded `undefined` behavior.
Under the recommendation, the default codec accepts JSON values: null, booleans, strings, finite numbers, arrays, and plain objects.
Every nested value belongs to that same domain.

Undefined, functions, symbols, BigInt, cycles, nonfinite numbers, sparse arrays, and unsupported object types fail encoding.
A custom codec can support additional types through its declared domain.
Under the recommended sentinel policy, no codec can return stored `undefined` as a live value.

That decode result rejects with `codec`.

Acceptance operates every permitted value type and its declared equality after a round trip.
It proves the selected missing representation for absent, expired, and stored entries.
It injects encode and decode errors that contain synthetic keys and values.
It makes sure that callers retain causes and observers contain only safe error codes.
It covers the selected codec column types and refuses incompatible existing table layouts.

## R13. Telemetry and hooks

Every public operation MUST implement T01 through T13 of the telemetry contract. [I6], [TEL]
Its INTERNAL span starts before input processing and surrounds the database work.
Driver instrumentation owns CLIENT spans and database duration metrics.
kvpg owns cache spans, cache metrics, and native log events.
Adapters do not duplicate observations for delegated operations.

Each signal and hook MUST obey the single T07 allowlist. [I13], [TEL]
No key, value, prefix, namespace, error cause, query text, or arbitrary error object enters observations.
The implementation MUST replace the unsafe error-bearing hook fields before release. [I13], [HOOK], [TEL]

The operation hook receives safe counts, elapsed milliseconds, and an optional safe error code.
It cannot change a result.
A failed hook triggers only the safe hook-error notice and the T10 record.

Nested hook failures do not recurse.

Acceptance uses in-memory exporters for traces, metrics, and logs with synthetic markers.
It covers concurrent parents, retries owned by the driver, failures, cleanup recovery, empty batches, and closed calls.
It operates no-provider, late-provider, sampled, and per-signal-off cases.
It proves one owner for each database observation and both Prometheus routes.
All four benchmark setups MUST operate before an overhead claim. [I6], [TEL]
The full counting, severity, attribute, and cost definitions remain in `docs/telemetry.md`.

## R14. Adapters

`fromPostgresJs(sql)` MUST return `TransactionalQueryable` and pass the portable suite on PostgreSQL 15 through 18. [I5]
It translates transactions without replacing the query parameter boundary.
The driver integration documents its database span owner.
Failure releases resources, and subsequent work remains possible.

The Keyv package MUST declare its supported major versions and operate each supported version independently. [I4], [I17]
For the selected Keyv interface, it MUST translate absolute Unix-millisecond expiry into `expiresAt` without a second relative-time calculation. [I4], [I17]
Keyv calculates that deadline on the host clock.
Relative `ttlMs` on the native store still uses the database clock.
The adapter advertises only capabilities that its selected interface supports.
Keyv 5 and Keyv 6 do not share an assumed identical storage interface.

Acceptance operates cache-manager 7 and a NestJS `CacheModule` integration for the declared compatible versions.
It proves a value round trip, expiry, missing reads, error propagation, and cleanup of owned adapter resources.
It measures clock-skew behavior for absolute adapter expiry and documents the result.
If the owner defers #17, the release scope and supported adapter claim need an explicit revision.

## R15. Portable acceptance suite

`@inkcasthq/kvpg-conformance` MUST export `conformance(name, factory)` on `node:test`, without another test framework. [I3]
The factory creates an empty isolated store and supplies disposal for its resources.
The suite MUST name at least one test for every S1 through S12 rule. [I3]

It MUST include ordered reads, concurrent conditional writes, concurrent cleanups, and literal wildcard prefixes. [I3], [EDGES]
It MUST include positive, negative, and recovery cases for the selected #11, #12, and #13 rules. [I10], [I11], [I12], [I13]
The suite also exposes shared telemetry conformance with in-memory exporters.

Optional future capabilities use separate suites rather than weaken the base contract.

The behavior-suite implementation under #3 includes its own reference in-memory store.
That reference is a test subject for the portable behavior suite.
It does not replace the real PostgreSQL subject for integration acceptance.
The suite MUST demonstrate that a planted expired-read defect fails S1 and that the corrected reference passes. [I3]
Both outputs belong to the acceptance evidence.
This specification stage does not implement that reference store.

Telemetry tests that need the absent store MUST remain pending with issue #2, rather than substitute a fake store. [I2], [TEL]
A pending test is an unmet release obligation.
The final supported matrix MUST finish with zero failed or pending acceptance cases. [I1], [I3], [I6]
Each implementation change MUST retain before-and-after test output for the behavior that it changes. [I2], [I3], [I4], [I5], [I6]

## R16. Measurements and release

Issue #7 MUST measure expiry-index choices at 100,000 and 10,000,000 rows, including HOT share and cleanup time per batch. [I7]
HOT means an update that creates no new index entry.
The benchmark MUST measure logged versus unlogged tables and `bytea` versus `jsonb` at one and eight clients. [I7]

It MUST publish read latency, write latency, WAL per write, machine details, versions, commands, and raw output. [I7]
WAL means the database record of changes for recovery.
`docs/benchmarks.md` contains the results.

`docs/design.md` links each measured decision to those results.
The benchmark also measures batch sizes and encoded value sizes at the #16 limits.
An affected default changes only after the measured result and owner decision.

Release automation MUST use npm trusted publishing on a tag without an npm credential stored in repository secrets. [I8]
The owner creates the required npm organization and trusted publisher entries.
The repository URL in each package matches its public repository.
The published packages MUST contain version 1.0.0 and provenance that links to the release workflow. [I1], [I8]
Publication MUST wait for the store, suite, adapter, telemetry, and measurement gates. [I1], [I8]
This build job does not authorize publication.

The final release evidence names the source SHA, supported matrix, selected owner decisions, and exact commands.
It includes complete failing and passing test counts, privacy results, and benchmark raw output.
It states each remaining limitation without a production cost claim that lacks measurement.

## R17. Deferred capabilities

The current horizon after 1.0 includes loader coordination, stale serving, tags, compression, encryption, counters, compare-and-set, distributed locks, memory tiers, eviction, sharding, and expiry partitions.
These features require explicit owner scope changes before implementation.
A loader does not change the hard expiry of the store.

A memory tier needs recovery after missed invalidation.
A distributed lock needs ownership, expiry, connection, and stale-writer rules.
An expiry partition needs a solution for uniqueness and atomic batches.

The release MUST NOT advertise an unqualified deferred capability. [I10], [FUTURE]

## Sources

Issue bodies come from the saved owner snapshot, read 2026-11-08.
Local source locations refer to `ba7f1c1`, except the telemetry contract at `c286bd2`.
Issue #6 includes the owner decision of 2026-11-08 23:00 UTC.

[I1]: https://github.com/inkcasthq/kvpg/issues/1 "Release scope and exit criteria, read 2026-11-08"
[I2]: https://github.com/inkcasthq/kvpg/issues/2 "Store and qualification, read 2026-11-08"
[I3]: https://github.com/inkcasthq/kvpg/issues/3 "Portable suite, read 2026-11-08"
[I4]: https://github.com/inkcasthq/kvpg/issues/4 "Keyv adapter, read 2026-11-08"
[I5]: https://github.com/inkcasthq/kvpg/issues/5 "postgres.js adapter, read 2026-11-08"
[I6]: https://github.com/inkcasthq/kvpg/issues/6 "Native telemetry and one spec, read 2026-11-08"
[I7]: https://github.com/inkcasthq/kvpg/issues/7 "Measured table choices, read 2026-11-08"
[I8]: https://github.com/inkcasthq/kvpg/issues/8 "Trusted publishing, read 2026-11-08"
[I10]: https://github.com/inkcasthq/kvpg/issues/10 "Contract decisions and horizons, read 2026-11-08"
[I11]: https://github.com/inkcasthq/kvpg/issues/11 "Conditional batches and duplicate keys, read 2026-11-08"
[I12]: https://github.com/inkcasthq/kvpg/issues/12 "Missing sentinel and codec equality, read 2026-11-08"
[I13]: https://github.com/inkcasthq/kvpg/issues/13 "Privacy in all signals and hooks, read 2026-11-08"
[I14]: https://github.com/inkcasthq/kvpg/issues/14 "Supported API/SDK pairs, read 2026-11-08"
[I16]: https://github.com/inkcasthq/kvpg/issues/16 "Size limits and cancellation, read 2026-11-08"
[I17]: https://github.com/inkcasthq/kvpg/issues/17 "Separate adapter qualification, read 2026-11-08"
[API]: ../packages/kvpg/src/contract.ts "packages/kvpg/src/contract.ts:6-77"
[EXT]: ../packages/kvpg/src/extension.ts "packages/kvpg/src/extension.ts:5-27"
[HOOK]: ../packages/kvpg/src/extension.ts "packages/kvpg/src/extension.ts:44-60, unsafe baseline types awaiting #13"
[S1]: standard.md#rules "docs/standard.md:17"
[S2]: standard.md#rules "docs/standard.md:19"
[S3]: standard.md#rules "docs/standard.md:21"
[S4]: standard.md#rules "docs/standard.md:23-27"
[S5]: standard.md#rules "docs/standard.md:29"
[S6]: standard.md#rules "docs/standard.md:31"
[S7]: standard.md#rules "docs/standard.md:33-37"
[S8]: standard.md#rules "docs/standard.md:39"
[S9]: standard.md#rules "docs/standard.md:41"
[S10]: standard.md#rules "docs/standard.md:43"
[S11]: standard.md#rules "docs/standard.md:45"
[S12]: standard.md#rules "docs/standard.md:47"
[VALUES]: standard.md#values "docs/standard.md:49-51"
[NS]: standard.md#namespaces "docs/standard.md:53-55"
[EDGES]: standard.md#conformance "docs/standard.md:59-64"
[DDL]: design.md#the-table "docs/design.md:24-32"
[CLOCK]: design.md#choices "docs/design.md:79"
[CLEAN]: design.md#choices "docs/design.md:81"
[POLICY]: extending.md#4-cleanup-policy "docs/extending.md:55-59 at baseline ba7f1c1"
[TEL]: telemetry.md "docs/telemetry.md:1-383 at c286bd2, T01-T13"
[LICENSE]: ../LICENSE "LICENSE:1-202 and README.md:37-39 at baseline ba7f1c1"
[FUTURE]: https://github.com/inkcasthq/kvpg/issues/10 "Issues #15 and #18-#22 list deferred capability contracts, read 2026-11-08"
