/**
 * The kvpg cache contract, version 0. docs/standard.md states the rules (S1 to S12) that each method must keep.
 * A store passes the contract when it passes the conformance suite (planned package @inkcasthq/kvpg-conformance).
 */

/** Options of one write. Give `ttlMs` or `expiresAt`, not both. */
export interface SetOptions {
  /** Time to live in milliseconds, a positive integer. Rule S4. */
  readonly ttlMs?: number;
  /** Absolute expiry. Rule S4. */
  readonly expiresAt?: Date;
  /** Write only when no live entry has the key. Rule S6. */
  readonly ifAbsent?: boolean;
}

/** One entry of a batch write. */
export interface Entry<V> {
  readonly key: string;
  readonly value: V;
  readonly options?: SetOptions;
}

/** The time left on a live entry. Rule S9. */
export type TimeToLive =
  | { readonly state: 'missing' }
  | { readonly state: 'persistent' }
  | { readonly state: 'expiring'; readonly ms: number };

/** The result of one cleanup run. Rule S10. */
export interface CleanupResult {
  readonly deleted: number;
  readonly batches: number;
}

/** A key-value cache with expiry. Each method rejects with a KvError when the store fails. Rule S12. */
export interface KvStore<V = unknown> {
  /** The value of a live entry, or undefined. A read never returns an expired entry. Rule S1. */
  get(key: string): Promise<V | undefined>;
  /** One result per key, in the order of `keys`. Rule S7. */
  getMany(keys: readonly string[]): Promise<Array<V | undefined>>;
  /** Insert or replace. Returns false only when `ifAbsent` is set and a live entry exists. Rules S2, S6. */
  set(key: string, value: V, options?: SetOptions): Promise<boolean>;
  /** Writes all entries in one transaction, or none. Rule S7. */
  setMany(entries: readonly Entry<V>[]): Promise<void>;
  /** True when a live entry was deleted. Rule S5. */
  delete(key: string): Promise<boolean>;
  /** The count of live entries deleted. Rule S7. */
  deleteMany(keys: readonly string[]): Promise<number>;
  /** Deletes every entry whose key starts with `prefix`, compared byte by byte. Rule S8. */
  deletePrefix(prefix: string): Promise<number>;
  /** True when a live entry has the key. Rule S1. */
  has(key: string): Promise<boolean>;
  /** Rule S9. */
  ttl(key: string): Promise<TimeToLive>;
  /** Sets a new expiry on a live entry. False when no live entry has the key. Rule S9. */
  expire(key: string, options: Pick<SetOptions, 'ttlMs' | 'expiresAt'>): Promise<boolean>;
  /** Removes the expiry of a live entry. False when no live entry has the key. Rule S9. */
  persist(key: string): Promise<boolean>;
  /** Deletes expired entries in batches. Rule S10. */
  cleanupExpired(options?: { readonly batchSize?: number; readonly maxBatches?: number }): Promise<CleanupResult>;
  /** Stops timers that the store started. It does not close a pool that the caller gave. Rule S11. */
  close(): Promise<void>;
}

/** The kinds of failure that a store reports. Rule S12. */
export type KvErrorCode = 'invalid_key' | 'invalid_ttl' | 'invalid_value' | 'codec' | 'driver' | 'closed';

/** The one error type of the contract. `cause` keeps the driver or codec error. */
export class KvError extends Error {
  readonly code: KvErrorCode;

  constructor(code: KvErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KvError';
    this.code = code;
  }
}
