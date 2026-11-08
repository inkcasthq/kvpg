# Extending kvpg

kvpg has five extension points. The types are in `packages/kvpg/src/extension.ts`. Each point has a default, so a plain setup needs none of them.

## 1. Driver

The store needs one method: `query(text, values)`, which returns `rows` and `rowCount`. A `pg` Pool and a `pg` Client already have it.

```ts
import pg from 'pg';
import { createStore } from '@inkcasthq/kvpg'; // issue #2

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = createStore({ db: pool });
```

`setMany` needs one transaction, so it needs `connect()` too (`TransactionalQueryable`). A `pg` Pool has it.

For another driver, write a small adapter. The adapter for postgres.js is issue #5.

## 2. Codec

A codec converts a value to the stored form and back, and names the column type.

```ts
import type { Codec } from '@inkcasthq/kvpg';

const text: Codec<string> = {
  name: 'text',
  column: 'text',
  encode: (value) => value,
  decode: (stored) => (typeof stored === 'string' ? stored : new TextDecoder().decode(stored)),
};
```

The table gets its column type at creation, and the type does not change after that. To change the codec of an existing table, you must migrate the table first.

## 3. Hooks

A hook observes a completed operation. Native OpenTelemetry is part of every store, as specified in `docs/telemetry.md` (issue #6). A hook receives safe counts, elapsed time, and an error code. It receives no keys, values, or error causes. The current error-bearing hook types need the safe replacements specified in T07 before release.

```ts
const store = createStore({
  db: pool,
  hooks: {
    onOperation: (event) => histogram.record(event.durationMs, { operation: event.operation }),
  },
});
```

A hook observes the operation after it ends. It cannot change the result. If a hook throws, the store catches the error. The `onHookError` observer receives only the safe notice specified in T07.

## 4. Cleanup policy

- `manual`: the application calls `cleanupExpired()`, for example from its own job runner. This is the default.
- `interval`: the store runs a cleanup on a timer in the process. The timer does not keep the process alive, and `close()` stops it.
- `pg_cron`: the store gives the SQL that schedules the cleanup in the database. The `pg_cron` extension must be installed.

Reads never return an expired entry (rule S1), so the policy changes only the size of the table, not the results.

## 5. Other stores

A store that is not PostgreSQL can keep the same contract. Implement `KvStore` from `packages/kvpg/src/contract.ts`, then run the conformance suite (issue #3) against it. The suite takes a function that makes an empty store:

```ts
import { conformance } from '@inkcasthq/kvpg-conformance'; // issue #3

conformance('my valkey store', async () => createValkeyStore({ url: process.env.VALKEY_URL }));
```

An application can then use one store in production and another in tests, with the same results.

## Adapters for frameworks

- Keyv (issue #4): a Keyv storage adapter, so that `cache-manager` and `@nestjs/cache-manager` can use kvpg. Keyv 6 gives the adapter an absolute expiry in Unix milliseconds, and kvpg stores it as `expires_at`.
