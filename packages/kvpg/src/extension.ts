/**
 * The extension points of kvpg. docs/extending.md explains each one with an example.
 */

/** The smallest query interface that kvpg needs. A `pg` Pool or Client has this shape. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** A source of connections for work that must run in one transaction, such as setMany. */
export interface TransactionalQueryable extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/** The column type that holds the encoded value. It is fixed when the table is created. */
export type ValueColumn = 'bytea' | 'text' | 'jsonb';

/** Converts a value to the column format and back. */
export interface Codec<V> {
  readonly name: string;
  readonly column: ValueColumn;
  encode(value: V): Uint8Array | string;
  decode(stored: Uint8Array | string): V;
}

/** The operations that hooks observe. */
export type Operation =
  | 'get'
  | 'getMany'
  | 'set'
  | 'setMany'
  | 'delete'
  | 'deleteMany'
  | 'deletePrefix'
  | 'has'
  | 'ttl'
  | 'expire'
  | 'persist'
  | 'cleanupExpired';

/** One completed operation, given to each hook. A hook gets no values, so it cannot leak cached data. */
export interface OperationEvent {
  readonly operation: Operation;
  readonly keys: number;
  readonly hits?: number;
  readonly durationMs: number;
  readonly error?: Error;
}

/**
 * Observers, for metrics and traces. A hook runs after the operation and cannot change its result.
 * A hook that throws is caught, and the error goes to `onHookError`.
 */
export interface Hooks {
  onOperation?(event: OperationEvent): void;
  onHookError?(error: unknown): void;
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
