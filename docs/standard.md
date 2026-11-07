# The kvpg cache contract, version 0

This document is the standard. The TypeScript form is `packages/kvpg/src/contract.ts`. To keep the contract, a store must pass the conformance suite (issue #3). Any store can pass it: the PostgreSQL store of this project, a Valkey store, or an in-memory store.

Version 0 can change before release 1.0. Each change gets a line in `CHANGELOG.md`.

## Terms

- Entry: a key, a value and an expiry time.
- Live entry: an entry whose expiry is after the current time of the store.
- Expired entry: an entry whose expiry is at or before the current time of the store. A cleanup deletes it later, so it can still be in the table.
- Persistent entry: an entry with no expiry.
- Time of the store: the clock that decides expiry. For the PostgreSQL store, it is `now()` of the database, not the clock of the client.

## Rules

S1. Reads never return an expired entry. `get`, `getMany`, `has` and `ttl` treat an expired entry as missing, whether or not a cleanup deleted it.

S2. `set` is an upsert. It replaces the value and the expiry of an existing entry, live or expired. When two writes race, the last write to commit wins.

S3. A key is a string of 1 to 1,024 UTF-8 bytes. It must not contain the NUL character. A store compares keys byte by byte. Otherwise the store rejects with `invalid_key`.

S4. Expiry:
- `ttlMs` is a positive safe integer. The expiry is the time of the store plus `ttlMs`.
- `expiresAt` is a valid `Date`. A date in the past makes the entry expired at once.
- Options with both, or with a `ttlMs` that is 0, negative or not an integer, reject with `invalid_ttl`.
- With neither, the store uses its default time to live. With no default, the entry is persistent.

S5. After it deletes a live entry, `delete` returns true. If the key has only an expired entry, `delete` deletes it and returns false.

S6. `set` with `ifAbsent` replaces an expired entry. If a live entry has the key, `set` makes no change and returns false.

S7. Batches:
- `getMany` returns one result for each key, in the order of the keys. A repeated key gets the same result each time.
- `setMany` writes all entries in one transaction, or none.
- `deleteMany` returns the count of live entries that it deleted.
- An empty batch makes no call to the database.

S8. `deletePrefix` deletes each entry whose key starts with the prefix, compared byte by byte. The characters `%`, `_` and `\` in the prefix have no special meaning. An empty prefix rejects with `invalid_key`, so that one call cannot empty the store.

S9. `ttl` returns `missing`, `persistent`, or `expiring` with the milliseconds left, rounded down. `expire` and `persist` change only a live entry. If no live entry has the key, they return false.

S10. `cleanupExpired` deletes expired entries in batches of `batchSize` (default 5,000). It stops after `maxBatches` (default no limit). A batch that deletes fewer rows than its size is also the last batch. Two cleanups at the same time do not block each other and do not delete a row twice. A cleanup never deletes a live entry.

S11. `close` stops each timer that the store started. It does not close a pool or a client that the caller gave to the store. After `close`, each call rejects with `closed`.

S12. Errors. Each failure rejects with one `KvError`, with a `code` of `invalid_key`, `invalid_ttl`, `invalid_value`, `codec`, `driver` or `closed`. The driver or codec error is its `cause`. A store never swallows an error. A cache layer above the store can choose to treat an error as a miss, but that choice is not part of the store.

## Values

The contract does not fix how a value is stored. A codec (`packages/kvpg/src/extension.ts`) converts a value to the stored form and back. A value that the codec cannot encode rejects with `invalid_value`. A stored value that the codec cannot decode rejects with `codec`.

## Namespaces

A namespace is a key prefix that the store adds, for example `orders:`. Two stores with different namespaces on one table do not see each other's entries. `deletePrefix` and `cleanupExpired` stay inside the namespace of the store.

## Conformance

The conformance suite (issue #3) has one test for each rule above. It also tests these edges:

- the order of `getMany`
- a race of two `set` calls with `ifAbsent`
- two cleanups at the same time
- a prefix with `%` and `_`

A store that passes all tests can state "kvpg contract v0".
