# kvpg 1.0 combined specification

This specification combines behavior, implementation logic, and release acceptance for epic #1.
It describes release 1.0.
The owner decisions of 2026-11-10 are binding, and `docs/decisions.md` records each one.
The cache contract `docs/standard.md` remains the authority for S1 through S14.
`contracts/` holds the JSON form of each operation, its result and its errors.

`MUST` states a requirement. `SHOULD` states a recommendation with a documented reason for each deviation.
The telemetry contract is `docs/telemetry.md`, T01 through T13.
This document incorporates that contract without creating a second telemetry definition.
Each normative paragraph cites an issue, a decision, a file location, or the telemetry contract.

## R01. Release scope

Release 1.0 MUST include the PostgreSQL store, portable conformance suite, Keyv adapter, postgres.js adapter, native telemetry, measured table choices, and release provenance. [I1]
It MUST also include the capabilities of #15 and #18 through #22, each with its own contract section, negative tests and recovery tests. [OD1]
The main package exports the contract, extension interfaces, `KvError`, and `createStore`.
The additional packages are `@inkcasthq/kvpg-conformance` and `@inkcasthq/kvpg-keyv`.
Each store and adapter MUST obey S1 through S14 and the telemetry contract. [I1], [I3], [I6]
The release MUST retain Apache-2.0 licensing and the existing notices. [LICENSE]
No server or new network protocol belongs to this release.

The build MUST pass on Node.js 22, 24, and 26. [I2]
The PostgreSQL store and postgres.js adapter MUST pass conformance on PostgreSQL 15, 16, 17, and 18. [I2], [I5]
PostgreSQL qualification uses real databases, not driver stubs alone.

## R02. Owner decisions

The owner decided each open choice on 2026-11-10. [OD1]
The table states each decided rule and its acceptance.
`docs/decisions.md` gives the full text, the reason and the source of each decision and each refinement.

| Choice | Decided rule | Acceptance |
|---|---|---|
| DECIDED #6: telemetry default | If the application registered a provider, the signal is on. Without a provider, each call is a no-op. Each store has an off switch. [OD2] | Operate the provider, no-provider and instance-off states, and prove no telemetry work without a provider |
| DECIDED #11a: conditional batches | `setMany` returns one outcome for each entry, `written` or `exists`. [OD3] | Prove both outcomes in one batch, a race of two batches, and the atomic rollback |
| DECIDED #11b: repeated batch keys | A key that is two or more times in one `setMany` rejects the batch with `invalid_batch` before any write. [OD3] | Prove the refusal with no database call, and a later valid batch |
| DECIDED #12: missing result | `get` and `getMany` return `{ found: true, value }` or `{ found: false }`. [OD4], [RF1] | Test absent, expired, stored and decoded `undefined` cases, and each codec round trip |
| DECIDED #14: API/SDK generation | API 1.9 and later with SDK 2. If `@opentelemetry/api-logs` is present, logs go through it. [OD5] | Operate each supported pair, no provider, late providers, the absent logs package, and instance off |
| DECIDED #16: size and batch bounds | Finite limits for each store, `maxValueBytes` and `maxBatchSize`, each with its own error code. [OD6], [RF6] | Operate each limit at the boundary and one item over it |
| DECIDED #16: cancellation | No abort interface in 1.0. A committed write stays authoritative. [OD6] | The documents state the lack of abort support |
| DECIDED #17: adapter qualification | Keyv 5, Keyv 6 and cache-manager 7, each qualified separately. The postgres.js adapter is in 1.0. [OD7] | State supported majors and operate each supported integration |
| DECIDED #7: measured table defaults | #7 measures D1, D5 and D6. The draft defaults stay unless the data shows otherwise. [OD1] | Publish raw measurements and update the design rationale |
| DECIDED #15 and #18 through #22: horizon | In 1.0. Each capability has its own contract section, R17 through R22. [OD1] | Each section lists its negative and recovery tests |
| DECIDED #2: prefix SQL | A key range with a code point upper bound. [RF9] | `EXPLAIN` shows an index range scan on PostgreSQL 15 through 18, also for a generic plan |

## R03. Store facade and driver logic

The call is `createStore({ db, codec, hooks, cleanup, table, namespace, defaultTtlMs, limits, telemetry })`.
Only `db` is required.
The store MUST accept a `Queryable` for every operation, `setMany` included. [I2], [EXT], [RF3]
`createStore` throws a `TypeError` or a `RangeError` for invalid configuration. [RF11]

The facade exposes `KvStore` plus `schemaSql()` and `migrate()`.
The contract types define each portable operation result. [API]
`contracts/` gives the same results as JSON Schema 2020-12.
`schemaSql()` resolves to DDL text without a database call.

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
No operation of this release takes a connection from a pool, so no operation needs a rollback path. [RF3]
The caller receives the driver error as the `cause` of the safe contract error.
Internal SQL is fixed apart from quoted identifiers and bounded statement structure.

Acceptance operates a Pool, a Client, and a driver that rejects.
A Client without `connect()` writes a nonempty `setMany`, because `setMany` is one statement. [RF3]
An empty batch makes no database call.
A connection failure, statement failure, and subsequent success each have a deterministic test.

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
The default codec stores JSON data in `bytea`. [RF18]

The table has no index on `expires_at` until #7 changes D1 from measurement.

Schema and table names MUST be quoted as PostgreSQL identifiers, including embedded quotes. [I2]
Keys and values MUST use query parameters. [I2]
An identifier MUST NOT become executable SQL through string concatenation without identifier quoting. [I2]
`schemaSql()` and `migrate()` MUST describe and apply the same table. [I2], [DDL]
Migration is explicit and repeatable through `CREATE TABLE IF NOT EXISTS`.
After that statement, `migrate()` reads the catalog of the table.
If the type or collation of `key`, `value` or `expires_at` differs from the configuration, `migrate()` rejects with `schema`. [RF19]
It never changes application data to make a table fit.

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
A key with a lone surrogate also rejects with `invalid_key`, so that two caller strings never merge into one stored key. [RF7]
The store does not normalize Unicode or change case.

The store MUST isolate namespaces for reads, writes, prefix deletion, and cleanup. [NS]
Simple raw concatenation is insufficient for overlapping namespace strings.
The stored key is `byteLength(namespace) + ':' + namespace + key`, also for the empty namespace. [RF8]
The namespace follows the key rules, but it can be empty. `createStore` refuses an invalid namespace with a `RangeError`.

The length uses UTF-8 bytes and a canonical decimal representation.
For example, namespaces `a` and `ab` then have different internal prefixes.
The 1,024-byte key limit applies before this internal framing.

Every query includes the namespace boundary, including cleanup queries.

Acceptance covers empty keys, NUL, lone surrogates, multibyte boundaries, a 1,024-byte key, and a 1,025-byte key.
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
`get` returns `{ found: true, value }` with the decoded live value, or `{ found: false }`. [OD4]
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

The PostgreSQL upsert is:

```sql
INSERT INTO public.kvpg_entries AS e (key, value, expires_at)
VALUES ($1, $2, COALESCE($3::timestamptz,
  now() + $4::bigint * interval '1 millisecond', 'infinity'))
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
RETURNING true AS written;
-- For ifAbsent, add this condition to the update:
-- WHERE e.expires_at <= now()
```

The implementation substitutes quoted identifiers and supplies all data through parameters.
It does not implement `ifAbsent` as a read followed by a write.
It reads each result from `RETURNING` rows, not from a nullable `rowCount`. [EXT]
`delete` MUST delete an expired row but return false for it. [S5]
For a deleted live row, it MUST return true. [S5]
For a missing row, it returns false.
The SQL returns `expires_at > now()` from the deleted row.

Acceptance covers replacement of value and expiry, persistence after an expiring value, and the reverse transition.
It uses barriers for racing writes and examines the result after both commits.
It operates conditional conflict, expired replacement, a driver error, and a successful retry by the caller.
The caller retry creates a separate public operation.

## R08. Batches: S7 and #11

`getMany` MUST return one read result for each requested occurrence, in input order. [S7], [RF1]
Repeated read keys MUST have the same result within that batch. [S7]
The implementation reads unique keys in one statement, then maps results back to occurrences.
It does not depend on the row order of `ANY($1)`.
A decode error rejects the complete read rather than return partial results.

`setMany` MUST return one write outcome for each entry, in input order. [OD3], [RF2]
An entry without `ifAbsent` gives `written`.
For an entry with `ifAbsent`: if a live entry has the key, the outcome is `exists`, and that entry does not change. Otherwise the outcome is `written`.
One batch can mix entries with and without `ifAbsent`.

Before any database call, `setMany` processes every key, expiry option and value.
If a key is two or more times in the batch, the call rejects with `invalid_batch`. [OD3]
Keys compare as stored keys, after the namespace frame.

`setMany` MUST write all written entries in one statement, so that all commit or none do. [S7], [RF3]
The statement has two data-modifying parts, one for the entries without `ifAbsent` and one for the entries with it:

```sql
WITH input AS (
  SELECT * FROM unnest($1::text[], $2::bytea[], $3::timestamptz[], $4::bigint[], $5::boolean[])
    AS i(key, value, expires_at, ttl_ms, if_absent)
), plain AS (
  INSERT INTO public.kvpg_entries AS e (key, value, expires_at)
  SELECT key, value, COALESCE(expires_at, now() + ttl_ms * interval '1 millisecond', 'infinity')
  FROM input WHERE NOT if_absent
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
  RETURNING e.key
), conditional AS (
  INSERT INTO public.kvpg_entries AS e (key, value, expires_at)
  SELECT key, value, COALESCE(expires_at, now() + ttl_ms * interval '1 millisecond', 'infinity')
  FROM input WHERE if_absent
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
  WHERE e.expires_at <= now()
  RETURNING e.key
)
SELECT key FROM plain UNION ALL SELECT key FROM conditional;
```

The value array type follows the codec column.
A key that the statement returns has the outcome `written`. Any other key has the outcome `exists`.
The keys are distinct, so no row changes twice in the statement.
No statement silently ignores a conditional conflict.

`deleteMany` MUST return the number of live entries deleted, not the number of requested occurrences. [S7]
Repeated delete keys therefore count once. [RF4]
Every empty batch MUST avoid all database calls. [S7]
It still obeys closed-store refusal and enabled telemetry.

Acceptance uses ordered hits and misses, repeated read keys, repeated delete keys, and each empty method.
It operates a batch with `written` and `exists` outcomes, and two racing conditional batches for one missing key.
It operates a repeated key and proves that no database call occurs, then a valid batch that succeeds.
A test table trigger fails one row, and the test proves that no entry of the batch was written.
After an error, the next independent batch succeeds.

## R09. Prefix deletion: S8

`deletePrefix` MUST compare the caller prefix byte by byte and treat `%`, `_`, and `\\` as literal characters. [S8]
An empty prefix MUST reject with `invalid_key`. [S8]
Its count is the number of live entries removed. [RF10]
Expired matching rows can also be removed without increasing that count.
The operation remains inside the framed namespace boundary.

The query MUST use the primary key index. [I2]
It is `DELETE ... WHERE key >= $1 AND key < $2 RETURNING expires_at > now() AS live`. [RF9]
`$1` is the framed prefix.
`$2` replaces the last code point of `$1` with the next code point, skips the surrogate range, and carries over U+10FFFF.
With `COLLATE "C"`, PostgreSQL compares the UTF-8 bytes, and UTF-8 keeps code point order.
The range then holds exactly the keys that start with `$1`.

`bench/prefix-plan.mjs` measured the plans on PostgreSQL 15.19, 16.15, 17.11, and 18.6. [PLAN]
The range form uses the primary key index for a custom plan and for a generic plan.
`starts_with(key, $1)` uses a sequential scan for a generic plan, so it is not used.

Acceptance covers exact prefix matches, adjacent nonmatches, backslashes, wildcard characters, and multibyte keys.
It covers prefixes that end with U+D7FF, U+FFFF, and U+10FFFF.
It proves namespace isolation and the empty-prefix refusal.
It captures `EXPLAIN` output on PostgreSQL 15 through 18.

## R10. Cleanup: S10

`cleanupExpired` MUST delete expired entries in batches, with default `batchSize` 5,000 and no default `maxBatches` limit. [S10]
It MUST stop at `maxBatches` or after a batch removes fewer rows than its size. [S10]
The result is `{ deleted, batches }` for confirmed batches, including the final short batch.

`batchSize` and `maxBatches` MUST be positive safe integers. Other values reject with `invalid_batch` before any database call. [RF5]
A `batchSize` over `maxBatchSize` rejects with `batch_too_large`. [S14], [RF6]

Two concurrent cleanups MUST skip locked candidates and never delete the same row twice. [S10], [CLEAN]
Cleanup MUST never delete a live entry or cross its namespace boundary. [S10], [NS]
The query uses `FOR UPDATE SKIP LOCKED` inside the candidate selection and a second expiry predicate in the deletion.
The candidate selection uses the key range of the namespace frame, so it uses the primary key index.

A short batch can mean that another transaction holds candidate locks.
It does not prove that no expired rows remain globally.
A later invocation retries the remaining work.
`batchSize` bounds deleted rows, not rows scanned or query duration.

Manual cleanup is the default policy.
An interval policy uses a timer that does not keep the process alive.
The interval loop prevents its own overlapping invocations.
A failed interval invocation does not stop the timer.

The `pg_cron` policy adds a `cron.schedule` statement to the output of `schemaSql()`.
The scheduled command is the cleanup statement of one batch, with the namespace frame as a SQL literal.
The application installs the extension. kvpg does not claim JavaScript observations for database-only execution.
None of the four test databases has `pg_cron`, so its runtime acceptance waits for a database that has it.
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
Close first marks the store closed, stops new scheduled work, and waits for accepted work to settle.

It then resolves without stopping application telemetry providers.
An accepted operation can still finish or fail through its normal path.
A second `close` rejects with `closed`, as S11 states for subsequent calls.

After close, `schemaSql()` also rejects with `closed` under S11.
`migrate()` obeys the same closed-state refusal as database operations.

Acceptance starts work, calls close, and proves that no new work enters the driver.
It releases the accepted work and awaits close.
It makes sure that interval callbacks do not start afterward and that caller queries still succeed.
It covers a failed accepted operation, a second close, and a separate live store on the same pool.

## R12. Values, codecs, and errors: S12 and #12

A codec converts application values to stored data and back.
Its column type remains fixed for a table.
An encode refusal MUST reject with `invalid_value`. [VALUES]

A decode failure MUST reject with `codec`. [VALUES]
A driver failure MUST reject with `driver`, and a closed operation MUST reject with `closed`. [S12]
Each failure MUST expose one `KvError` with the corresponding code and the original driver or codec cause. [S12]

The store MUST NOT convert an operational failure into a cache miss. [S12]
Cause retention is caller behavior, never permission to publish the cause through telemetry.

A read returns `{ found: true, value }` or `{ found: false }`. [OD4]
A stored `undefined` from a custom codec is a live value: `{ found: true, value: undefined }`.
The default codec `json` accepts the JSON data model: null, booleans, strings, finite numbers, arrays, and plain objects. [RF18]
Every nested value belongs to that same domain.

Undefined, functions, symbols, BigInt, cycles, nonfinite numbers, sparse arrays, and unsupported object types fail encoding with `invalid_value`.
A round trip keeps JSON equality: object key order does not count, and `-0` becomes `0`.
A custom codec states its own domain and round trip.

Acceptance operates every permitted value type and its declared equality after a round trip.
It proves the read result for absent, expired, and stored entries, and for a stored `undefined` through a custom codec.
It injects encode and decode errors that contain synthetic keys and values.
It makes sure that callers retain causes and observers contain only safe error codes.
It covers the codec column types and refuses incompatible existing table layouts with `schema`. [RF19]

## R13. Telemetry and hooks

Every public operation MUST implement T01 through T13 of the telemetry contract. [I6], [TEL]
Its INTERNAL span starts before input processing and surrounds the database work.
Driver instrumentation owns CLIENT spans and database duration metrics.
kvpg owns cache spans, cache metrics, and native log events.
Adapters do not duplicate observations for delegated operations.

Each operation records the RED metrics of T09: a call count, an error count by code, and a duration histogram. [OD9], [RF13]
Without a provider and without a hook, the operation does no telemetry work. [OD2], [RF12]

Each signal and hook MUST obey the single T07 allowlist. [I13], [TEL]
No key, value, prefix, namespace, error cause, query text, or arbitrary error object enters observations.
The hook types carry only safe fields. [HOOK], [TEL]

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

`fromPostgresJs(sql)` MUST return `TransactionalQueryable` and pass the portable suite on PostgreSQL 15 through 18. [I5], [OD7]
It translates transactions without replacing the query parameter boundary.
The driver integration documents its database span owner.
Failure releases resources, and subsequent work remains possible.
postgres.js prepares named statements, so the store SQL MUST keep an index plan for a generic plan. [PLAN]

The Keyv package MUST qualify Keyv 5, Keyv 6, and cache-manager 7, each one separately. [I4], [OD7]
For each Keyv interface, it MUST translate absolute Unix-millisecond expiry into `expiresAt` without a second relative-time calculation. [I4], [I17]
Keyv calculates that deadline on the host clock.
Relative `ttlMs` on the native store still uses the database clock.
The adapter maps `{ found: false }` to the missing value of each Keyv interface, and `{ found: true, value }` to `value`. [OD4]
The adapter advertises only capabilities that its interface supports.
Keyv 5 and Keyv 6 do not share an assumed identical storage interface.

Acceptance operates cache-manager 7 and a NestJS `CacheModule` integration for each qualified version.
It proves a value round trip, expiry, missing reads, error propagation, and cleanup of owned adapter resources.
It measures clock-skew behavior for absolute adapter expiry and documents the result.

## R15. Portable acceptance suite

`@inkcasthq/kvpg-conformance` MUST export `conformance(name, factory)` on `node:test`, without another test framework. [I3]
The factory creates an empty isolated store and supplies disposal for its resources.
The suite MUST name at least one test for every S1 through S14 rule. [I3]

It MUST include ordered reads, concurrent conditional writes, concurrent cleanups, and literal wildcard prefixes. [I3], [EDGES]
It MUST include positive, negative, and recovery cases for the #11, #12, #13, and #16 rules. [I10], [I11], [I12], [I13], [OD6]
The shared telemetry conformance with in-memory exporters is in `test/telemetry/`.

Optional capabilities use separate suites rather than weaken the base contract.

The suite has its own reference in-memory store.
That reference is a test subject for the portable behavior suite.
It does not replace the real PostgreSQL subject for integration acceptance.
The suite MUST demonstrate that a planted expired-read defect fails S1 and that the corrected reference passes. [I3]
Both outputs belong to the acceptance evidence.

A telemetry case that needs a missing fixture stays pending with its issue, rather than substitute a fake. [I2], [TEL]
A pending test is an unmet release obligation.
The final supported matrix MUST finish with zero failed or pending acceptance cases. [I1], [I3], [I6]
Each implementation change MUST retain before-and-after test output for the behavior that it changes. [I2], [I3], [I4], [I5], [I6]

## R16. Limits and cancellation: S14 and #16

Each store has two finite limits, set in `createStore({ limits })`. [OD6], [RF6]

| Limit | Applies to | Provisional default | Code over the limit |
|---|---|---|---|
| `maxValueBytes` | The encoded size of each value of `set` and `setMany` | 1,048,576 bytes | `value_too_large` |
| `maxBatchSize` | The entries of `getMany`, `setMany` and `deleteMany`, and the `batchSize` of `cleanupExpired` | 5,000 | `batch_too_large` |

A value or a batch exactly at its limit is accepted.
The limit applies before any database call.
A limit MUST be a positive safe integer. `createStore` refuses any other value with a `RangeError`. [RF11]
#7 measures the cost at each limit. A default changes only after that measurement. [OD6]

Release 1.0 has no abort interface. [OD6]
A caller that stops waiting does not cancel an operation.
A write that committed stays committed and authoritative.

Acceptance operates each limit at the boundary and one item over it, on every operation that the limit covers.
It proves that the over-limit call makes no database call, and that a later call within the limit succeeds.
It proves that a store with a lower limit refuses a value that another store accepts.

## R17. Capability: cache loader (#15)

The loader is a cache layer above any `KvStore`. It does not change `get`. [OD1]

```ts
createLoader<V>(store: KvStore<LoaderEntry<V>>, options?: { freshMs?: number }): Loader<V>;
interface Loader<V> {
  load(key: string, fetch: (key: string) => Promise<V>, options?: LoadOptions): Promise<LoadResult<V>>;
  set(key: string, value: V, options?: LoadOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  close(): Promise<void>;
}
type LoadResult<V> = { value: V; source: 'store' | 'loader' | 'stale' };
```

Rules:

- L1. One `fetch` runs for each key in one loader at a time. Concurrent callers of that key share its result.
- L2. A fresh entry returns `source: 'store'`, and `fetch` does not run.
- L3. A live entry after its freshness deadline returns `source: 'stale'` and starts one background refresh. The hard expiry of the store still governs S1.
- L4. The freshness deadline is part of the stored entry. It uses the host clock, and the hard expiry uses the database clock.
- L5. If `fetch` fails, every waiter rejects with `KvError` code `loader`, and its cause is the fetch error. Nothing is written.
- L6. If `set` or `delete` of the loader runs during a load, the load returns its value to its waiters but does not write it.
- L7. A store error rejects the load with the store `KvError`. The loader never treats an error as a miss.
- L8. No abort exists (OD6). After `close`, new loads reject with `closed`. `close` waits for pending loads, and it does not close the store.

New code: `loader`.
Telemetry: one INTERNAL span `kvpg.load`, with the store spans as children. The field `kvpg.load.source` joins T07 in its build phase.

Negative tests: a failing `fetch`, a value that the codec refuses, a store driver error, a call after `close`.
Recovery tests: a load after a failed load succeeds, a refresh after a failed refresh succeeds, and the store works after the loader closes.

## R18. Capability: namespace clear and tags (#18)

`clearNamespace(): Promise<number>` deletes every entry of the namespace of the store and returns the count of live entries deleted.
With the empty namespace, it rejects with `invalid_key`, because that namespace frame matches every unnamespaced key.
`deletePrefix` keeps its refusal of an empty prefix (S8).

Tags are an option of each write: `set(key, value, { tags })` and `Entry.options.tags`.
`deleteTag(tag): Promise<number>` deletes each entry with the tag and returns the count of live entries deleted.
A store with tags has a second table, `<table>_tags (tag, key)`, with `COLLATE "C"` on both columns.
Its primary key is `(tag, key)`. Its foreign key to the entry has `ON DELETE CASCADE`.

Rules:

- G1. A write replaces the full tag set of the key in the same statement as the value.
- G2. A tag is a well-formed string of 1 to 256 UTF-8 bytes without NUL. Otherwise the write rejects with `invalid_tag`.
- G3. An entry has at most `maxTagsPerEntry` tags (default 16). More tags reject with `too_many_tags`.
- G4. `deleteTag` deletes the entries that have the tag in its statement snapshot. A write that commits after that snapshot stays.
- G5. Cleanup and delete remove tag rows through the cascade. Tags stay inside the namespace of the store.
- G6. A tag is private data under S13. No signal holds a tag.

New codes: `invalid_tag`, `too_many_tags`.
Negative tests: an empty tag, NUL, a 257-byte tag, 17 tags, `clearNamespace` with the empty namespace.
Recovery tests: `deleteTag` after a driver error, a write after `clearNamespace`, and a tag race that keeps the later write.

## R19. Capability: compression and encryption codecs (#19)

Both are codec wrappers with the `bytea` column.
Each stored value starts with an envelope: the four bytes `KVPG`, a format version byte, and a kind byte.

- Compression: `compressCodec(inner, { algorithm: 'gzip' | 'brotli', maxDecodedBytes })`.
- Encryption: `encryptCodec(inner, { keys, activeKeyId })` with AES-256-GCM, a random 12-byte IV, and a 16-byte tag. The envelope holds the key ID.

Rules:

- E1. A wrong marker, an unknown version, or an unknown kind rejects the read with `codec`.
- E2. A decoded value larger than `maxDecodedBytes` rejects with `codec`. The decoder stops at that size.
- E3. A write encrypts with `activeKeyId`. A read accepts each key in `keys`. An unknown key ID or a wrong authentication tag rejects with `codec`.
- E4. Key rotation: add the new key, set it active, and rewrite the entries. The codec never rewrites an entry by itself.
- E5. A key, an IV, and plain data never go into a signal or an error message.

Negative tests: a truncated envelope, a wrong marker, an unknown version, changed ciphertext, an unknown key ID, and a value over `maxDecodedBytes`.
Recovery tests: after rotation, old entries stay readable and new entries use the new key. After the old key is removed, old entries reject with `codec` and new entries still read.

## R20. Capability: counters and compare-and-set (#20)

Both are optional capabilities, with their own conformance suite. A store that does not have them still passes the base suite.

`increment(key, delta = 1, options?): Promise<number>`:

- N1. The counter is a safe integer in the `json` codec. `delta` is a safe integer. Otherwise the call rejects with `invalid_value`.
- N2. A missing or expired key starts at 0 and takes the expiry of `options`, or the default.
- N3. A live key keeps its expiry. One statement reads and writes the value, so concurrent increments do not lose an update.
- N4. If the live value is not a safe integer, the call rejects with `not_a_counter`.
- N5. If the result leaves the safe integer range, the call rejects with `counter_overflow` and the value does not change.

`compareAndSet(key, expected: ReadResult<V>, value: V, options?): Promise<'written' | 'mismatch'>`:

- M1. With `{ found: false }`: if a live entry has the key, nothing changes. Otherwise the write occurs.
- M2. With `{ found: true, value }`: if the stored bytes differ from the codec encoding of that value, nothing changes. Otherwise the write occurs.
- M3. A mismatch changes nothing and returns `mismatch`. The comparison is the byte equality of the codec, so the codec must be deterministic.

New codes: `not_a_counter`, `counter_overflow`.
Negative tests: a counter over a text value, a delta of 0.5, an overflow, a mismatch.
Recovery tests: a counter after its key expired, and a compare-and-set after a mismatch with a fresh read.

## R21. Capability: distributed locks and a memory tier (#21)

A `Queryable` gives no fixed session. `TransactionalQueryable.connect()` gives one connection until its release.
kvpg 1.0 uses no session advisory lock, so locks work through transaction pooling.

Locks are leases in a lock table:

```ts
acquireLock(name: string, options: { ttlMs: number }): Promise<LockLease | null>;
renewLock(lease: LockLease, options: { ttlMs: number }): Promise<boolean>;
releaseLock(lease: LockLease): Promise<boolean>;
type LockLease = { name: string; token: string; fence: number; expiresAt: Date };
```

- K1. If no live lease has the name, `acquireLock` returns a new lease. Otherwise it returns `null`. The database clock decides expiry.
- K2. The token is random. `renewLock` and `releaseLock` act only with the token of a live lease, and otherwise return false.
- K3. `fence` grows by one with each new lease of a name. A downstream writer refuses a write with an older fence.
- K4. A lost connection ends no lease. The lease ends at its expiry.

The memory tier is `createTieredStore(store, { maxEntries, localTtlMs, listen })`:

- T1. A local entry lives until the earliest of its local time to live and its store expiry.
- T2. A write through the tier sends `NOTIFY` with a hashed key. Each tier with `listen` holds one connection from `connect()` for `LISTEN`.
- T3. If the listener connection fails, the tier clears all local entries before it serves the next read, because missed notifications cannot replay.
- T4. `close` stops the listener and releases its connection. It does not close the pool of the caller.
- T5. `LISTEN` does not work through transaction pooling. With such a pool, `listen` must be false.

Negative tests: a release with a wrong token, a renew after expiry, a stale fence, a tier read after a lost listener.
Recovery tests: a new lease after expiry, and correct reads after the listener reconnects.

## R22. Capability: capacity rules (#22)

#7 measures each option before it is built. [OD1]

- P1. Eviction is a policy of each namespace, `capacity: { maxEntries }`. It is approximate.
- P2. Eviction removes live expiring entries, the earliest expiry first. It never evicts a persistent entry.
- P3. A sharded store routes each key to one shard. A batch whose keys go to more than one shard rejects with `invalid_batch`, so S7 atomicity holds.
- P4. A table partitioned by expiry is refused in 1.0. On a partitioned table, PostgreSQL requires each unique key to include the partition key.
  The upsert of S2 needs a unique key on `key` alone.

Negative tests: a cross-shard batch, a persistent entry over the capacity.
Recovery tests: eviction after a failed eviction run, and a batch after a cross-shard refusal.

## R23. Measurements and release

Issue #7 MUST measure expiry-index choices at 100,000 and 10,000,000 rows, including HOT share and cleanup time per batch. [I7]
HOT means an update that creates no new index entry.
The benchmark MUST measure logged versus unlogged tables and `bytea` versus `jsonb` at one and eight clients. [I7]

It MUST publish read latency, write latency, WAL per write, machine details, versions, commands, and raw output. [I7]
WAL means the database record of changes for recovery.
`docs/benchmarks.md` contains the results.

`docs/design.md` links each measured decision to those results.
The benchmark also measures batch sizes and encoded value sizes at the S14 limits, and the options of R22.
An affected default changes only after the measured result and owner decision.

Release automation MUST use npm trusted publishing on a tag without an npm credential stored in repository secrets. [I8]
The owner creates the required npm organization and trusted publisher entries.
The repository URL in each package matches its public repository.
The published packages MUST contain version 1.0.0 and provenance that links to the release workflow. [I1], [I8]
Publication MUST wait for the store, suite, adapter, telemetry, capability, and measurement gates. [I1], [I8]
This build job does not authorize publication.

The final release evidence names the source SHA, supported matrix, owner decisions, and exact commands.
It includes complete failing and passing test counts, privacy results, and benchmark raw output.
It states each remaining limitation without a production cost claim that lacks measurement.
The release MUST NOT advertise a capability that has not passed its own suite. [OD1]

## Sources

Issue bodies come from the saved owner snapshot, read 2026-11-08.
The owner decisions of 2026-11-10 come from the issue comments that `docs/decisions.md` links.
Local source locations refer to the files of this release.

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
[HOOK]: ../packages/kvpg/src/extension.ts "packages/kvpg/src/extension.ts, the safe hook types of T07"
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
[POLICY]: extending.md#4-cleanup-policy "docs/extending.md, section 4"
[TEL]: telemetry.md "docs/telemetry.md, T01-T13"
[LICENSE]: ../LICENSE "LICENSE and README.md"
[FUTURE]: https://github.com/inkcasthq/kvpg/issues/10 "Issues #15 and #18-#22 list the capability contracts, read 2026-11-08"
[PLAN]: ../bench/prefix-plan.mjs "Prefix plans on PostgreSQL 15-18, results in bench/results/prefix-plan-2026-11-10.jsonl"
[OD1]: decisions.md#owner-decisions "Owner decision OD1"
[OD2]: decisions.md#owner-decisions "Owner decision OD2"
[OD3]: decisions.md#owner-decisions "Owner decision OD3"
[OD4]: decisions.md#owner-decisions "Owner decision OD4"
[OD5]: decisions.md#owner-decisions "Owner decision OD5"
[OD6]: decisions.md#owner-decisions "Owner decision OD6"
[OD7]: decisions.md#owner-decisions "Owner decision OD7"
[OD8]: decisions.md#owner-decisions "Owner decision OD8"
[OD9]: decisions.md#owner-decisions "Owner decision OD9"
[RF1]: decisions.md#refinements "Refinement RF1"
[RF2]: decisions.md#refinements "Refinement RF2"
[RF3]: decisions.md#refinements "Refinement RF3"
[RF4]: decisions.md#refinements "Refinement RF4"
[RF5]: decisions.md#refinements "Refinement RF5"
[RF6]: decisions.md#refinements "Refinement RF6"
[RF7]: decisions.md#refinements "Refinement RF7"
[RF8]: decisions.md#refinements "Refinement RF8"
[RF9]: decisions.md#refinements "Refinement RF9"
[RF10]: decisions.md#refinements "Refinement RF10"
[RF11]: decisions.md#refinements "Refinement RF11"
[RF12]: decisions.md#refinements "Refinement RF12"
[RF13]: decisions.md#refinements "Refinement RF13"
[RF14]: decisions.md#refinements "Refinement RF14"
[RF15]: decisions.md#refinements "Refinement RF15"
[RF16]: decisions.md#refinements "Refinement RF16"
[RF17]: decisions.md#refinements "Refinement RF17"
[RF18]: decisions.md#refinements "Refinement RF18"
[RF19]: decisions.md#refinements "Refinement RF19"
[RF20]: decisions.md#refinements "Refinement RF20"
