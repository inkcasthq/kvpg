# The kvpg cache contract, version 1

This document is the standard. The TypeScript form is `packages/kvpg/src/contract.ts`. The JSON form of each operation is in `contracts/`. To keep the contract, a store must pass the conformance suite `@inkcasthq/kvpg-conformance` (issue #3). Any store can pass it: the PostgreSQL store of this project, a Valkey store, or an in-memory store.

Version 1 is the contract of release 1.0. `docs/decisions.md` gives the reason for each change from version 0. Each change also gets a line in `CHANGELOG.md`.

## Terms

- Entry: a key, a value and an expiry time.
- Live entry: an entry whose expiry is after the current time of the store.
- Expired entry: an entry whose expiry is at or before the current time of the store. A cleanup deletes it later, so it can still be in the table.
- Persistent entry: an entry with no expiry.
- Time of the store: the clock that decides expiry. For the PostgreSQL store, it is `now()` of the database, not the clock of the client.
- Read result: `{ found: true, value }` for a live entry, or `{ found: false }`.
- Write outcome: `written` or `exists`.

## Rules

S1. Reads never return an expired entry. `get`, `getMany`, `has` and `ttl` treat an expired entry as missing, whether or not a cleanup deleted it. For a live entry, `get` returns `{ found: true, value }`. For a missing or expired entry, it returns `{ found: false }`. A stored `undefined` is a live value, so it gives `{ found: true, value: undefined }`.

S2. `set` is an upsert. It replaces the value and the expiry of an existing entry, live or expired. When two writes race, the last write to commit wins. After a write, `set` returns true.

S3. A key is a well-formed string of 1 to 1,024 UTF-8 bytes. It must not contain the NUL character or a lone surrogate. A store compares keys byte by byte. Otherwise the store rejects with `invalid_key`.

S4. Expiry:
- `ttlMs` is a positive safe integer. The expiry is the time of the store plus `ttlMs`.
- `expiresAt` is a valid `Date`. A date in the past makes the entry expired at once.
- Options with both, or with a `ttlMs` that is 0, negative or not a safe integer, reject with `invalid_ttl`.
- With neither, the store uses its default time to live. With no default, the entry is persistent.

S5. After it deletes a live entry, `delete` returns true. If the key has only an expired entry, `delete` deletes it and returns false.

S6. `set` with `ifAbsent` replaces an expired entry. If a live entry has the key, `set` makes no change and returns false.

S7. Batches:
- `getMany` returns one read result for each key, in the order of the keys. A repeated key gets the same result each time.
- `setMany` returns one write outcome for each entry, in the order of the entries. An entry without `ifAbsent` gives `written`. For an entry with `ifAbsent`: if a live entry has the key, the outcome is `exists` and the store does not change that entry. Otherwise the outcome is `written`.
- `setMany` writes all its written entries in one transaction, or none.
- If a key is in one `setMany` two or more times, the call rejects with `invalid_batch` before any write.
- `deleteMany` returns the count of live entries that it deleted. A repeated key counts once.
- An empty batch makes no call to the database.

S8. `deletePrefix` deletes each entry whose key starts with the prefix, compared byte by byte. The characters `%`, `_` and `\` in the prefix have no special meaning. It returns the count of live entries that it deleted. An empty prefix rejects with `invalid_key`, so that one call cannot empty the store.

S9. `ttl` returns `missing`, `persistent`, or `expiring` with the milliseconds left, rounded down. `expire` and `persist` change only a live entry. If no live entry has the key, they return false. `expire` needs `ttlMs` or `expiresAt`. With neither, it rejects with `invalid_ttl`.

S10. `cleanupExpired` deletes expired entries in batches of `batchSize` (default 5,000). It stops after `maxBatches` (default no limit). A batch that deletes fewer rows than its size is also the last batch. Two cleanups at the same time do not block each other and do not delete a row twice. A cleanup never deletes a live entry.

S11. `close` stops each timer that the store started. It does not close a pool or a client that the caller gave to the store. After `close`, each call rejects with `closed`.

S12. Errors. Each failure rejects with one `KvError`, with one of these codes:

| Code | Failure |
|---|---|
| `invalid_key` | The key or the prefix breaks S3 or S8 |
| `invalid_ttl` | The expiry options break S4 |
| `invalid_value` | The codec cannot encode the value |
| `invalid_batch` | A key is two or more times in one `setMany`, or a batch argument is not valid |
| `value_too_large` | The encoded value is larger than the `maxValueBytes` limit (S14) |
| `batch_too_large` | A batch is larger than the `maxBatchSize` limit (S14) |
| `codec` | The codec cannot decode a stored value |
| `driver` | The database or the driver failed |
| `schema` | `migrate()` found a table that does not match the store configuration |
| `closed` | The store is closed |

The driver or codec error is its `cause`. A store never swallows an error. A cache layer above the store can choose to treat an error as a miss, but that choice is not part of the store.

S13. Privacy. No span, metric, log record, event or hook argument of kvpg holds private data, in any form. Private data is a key, a prefix, a namespace, a value or an error cause. `docs/telemetry.md` (T07) names the one list of permitted fields. The `cause` of a `KvError` stays with the caller.

S14. Limits. Each store has two finite limits, set for each store:
- `maxValueBytes`: the largest encoded value, in bytes. A larger value rejects with `value_too_large` before any write.
- `maxBatchSize`: the most entries in one `getMany`, `setMany` or `deleteMany`, and the largest `batchSize` of `cleanupExpired`. A larger batch rejects with `batch_too_large` before any database call.

A limit is a positive safe integer. A value exactly at the limit is accepted. The store has no abort interface. A write that committed stays committed. The caller cannot cancel it by stopping its wait.

## Values

The contract does not fix how a value is stored. A codec (`packages/kvpg/src/extension.ts`) converts a value to the stored form and back. A value that the codec cannot encode rejects with `invalid_value`. A stored value that the codec cannot decode rejects with `codec`.

Each codec states the values that it accepts and its round trip. The default codec, `json`, accepts the JSON data model: `null`, booleans, strings, finite numbers, arrays and plain objects, nested at any depth. A round trip gives a value that is equal as JSON data: the order of object keys does not count, and `-0` becomes `0`. It refuses `undefined`, functions, symbols, BigInt values, cycles, non-finite numbers, sparse arrays and objects that are not plain.

## Namespaces

A namespace is a key prefix that the store adds, for example `orders:`. Two stores with different namespaces on one table do not see each other's entries. `deletePrefix` and `cleanupExpired` stay inside the namespace of the store.

## Conformance

The conformance suite (issue #3) has at least one test for each rule above. It also tests these edges:

- the order of `getMany`
- a race of two `set` calls with `ifAbsent`
- two cleanups at the same time
- a prefix with `%` and `_`
- a `setMany` with `ifAbsent` entries that give `written` and `exists`
- a `setMany` with a repeated key
- a value and a batch at each limit and one over it

A store that passes all tests can state "kvpg contract v1".
