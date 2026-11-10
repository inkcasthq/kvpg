/**
 * The extension points of kvpg. docs/extending.md explains each one with an example.
 */
import type { KvErrorCode, KvStore, Limits } from './contract.js';

/** The smallest query interface that kvpg needs. A `pg` Pool or Client has this shape. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A source of connections for work that must run in one transaction. Release 1.0 needs it only for R21. */
export interface TransactionalQueryable extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/** The column type that holds the encoded value. It is fixed when the table is created. */
export type ValueColumn = 'bytea' | 'text' | 'jsonb';

/** Converts a value to the column format and back. An encode error gives `invalid_value`, a decode error `codec`. */
export interface Codec<V> {
  readonly name: string;
  readonly column: ValueColumn;
  encode(value: V): Uint8Array | string;
  decode(stored: Uint8Array | string): V;
}

/** The public operations, in the order of the T04 table of docs/telemetry.md. */
export const OPERATIONS = Object.freeze([
  'get',
  'getMany',
  'set',
  'setMany',
  'delete',
  'deleteMany',
  'deletePrefix',
  'has',
  'ttl',
  'expire',
  'persist',
  'cleanupExpired',
  'close',
  'schemaSql',
  'migrate',
] as const);

/** The operations that hooks and telemetry observe. */
export type Operation = (typeof OPERATIONS)[number];

/**
 * One completed operation, given to each hook. It holds safe fields only (T07), so it cannot leak cached data.
 * `keys` counts the key occurrences that the call supplied, 0 for an operation without keys.
 * `hits` is set for a successful `get`, `getMany`, `has` or `ttl`. `errorCode` is set for a failure.
 */
export interface OperationEvent {
  readonly operation: Operation;
  readonly keys: number;
  readonly hits?: number;
  readonly durationMs: number;
  readonly errorCode?: KvErrorCode;
}

/** The only argument of `onHookError`. It never carries the thrown value. */
export interface HookErrorNotice {
  readonly code: 'hook';
}

/**
 * Observers, for metrics and traces. A hook runs after the operation and cannot change its result.
 * A hook that throws is caught, and `onHookError` gets a notice. A throwing `onHookError` is ignored.
 */
export interface Hooks {
  onOperation?(event: OperationEvent): void;
  onHookError?(notice: HookErrorNotice): void;
}

/** When expired rows are deleted. docs/design.md compares the options. */
export type CleanupPolicy =
  | { readonly kind: 'manual' }
  | { readonly kind: 'interval'; readonly everyMs: number; readonly batchSize?: number }
  | { readonly kind: 'pg_cron'; readonly schedule: string; readonly batchSize?: number };

/** The physical table. docs/design.md gives the reason for each default. */
export interface TableOptions {
  /** Default 'public'. */
  readonly schema?: string;
  /** Default 'kvpg_entries'. */
  readonly table?: string;
  /** Default false. An unlogged table is emptied after a crash and has no rows on a replica. */
  readonly unlogged?: boolean;
  /** Default 70, so that an update finds room on its page and stays a HOT update. */
  readonly fillfactor?: number;
}

/**
 * The telemetry switches of one store (T03). With a registered provider a signal is on, without one it is a no-op.
 * `false` or `{ enabled: false }` turns all signals off for this store.
 */
export type TelemetryOptions =
  | boolean
  | {
      readonly enabled?: boolean;
      readonly traces?: boolean;
      readonly metrics?: boolean;
      readonly logs?: boolean;
      /** A finite positive number of milliseconds. Omitted: no slow-operation records. */
      readonly slowOperationMs?: number;
    };

/** The configuration of `createStore`. Only `db` is required (R03). */
export interface StoreOptions<V = unknown> {
  readonly db: Queryable;
  /** Default: the `json` codec in a `bytea` column. */
  readonly codec?: Codec<V>;
  readonly hooks?: Hooks;
  /** Default: manual cleanup. */
  readonly cleanup?: CleanupPolicy;
  readonly table?: TableOptions;
  /** Default: the empty namespace. It follows the key rules of S3, but it can be empty. */
  readonly namespace?: string;
  /** The time to live of a write without expiry options. Omitted: such an entry is persistent. */
  readonly defaultTtlMs?: number;
  /** Default: `DEFAULT_LIMITS`. */
  readonly limits?: Limits;
  readonly telemetry?: TelemetryOptions;
}

/** The PostgreSQL store: the portable contract plus its schema helpers (R03, R04). */
export interface PostgresStore<V = unknown> extends KvStore<V> {
  /** The DDL of the configured table, made without a database call. */
  schemaSql(): Promise<string>;
  /** Applies `schemaSql()` and makes sure that an existing table has the configured columns. */
  migrate(): Promise<void>;
}
