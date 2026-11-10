/**
 * The kvpg cache contract, version 1. docs/standard.md states the rules (S1 to S14) that each method must keep.
 * contracts/ gives the same payloads as JSON Schema 2020-12, and test/contracts/drift.test.mjs keeps both equal.
 * A store passes the contract when it passes the conformance suite (package @inkcasthq/kvpg-conformance).
 */

/** The expiry of one write. Give `ttlMs` or `expiresAt`, not both. Rule S4. */
export interface ExpiryOptions {
  /** Time to live in milliseconds, a positive safe integer. */
  readonly ttlMs?: number;
  /** Absolute expiry. A date in the past makes the entry expired at once. */
  readonly expiresAt?: Date;
}

/** Options of one write. Rules S4 and S6. */
export interface SetOptions extends ExpiryOptions {
  /** Write only when no live entry has the key. Rule S6. */
  readonly ifAbsent?: boolean;
}

/** One entry of a batch write. */
export interface Entry<V> {
  readonly key: string;
  readonly value: V;
  readonly options?: SetOptions;
}

/** The result of a read. A stored `undefined` is a live value: `{ found: true, value: undefined }`. Rule S1. */
export type ReadResult<V> = { readonly found: true; readonly value: V } | { readonly found: false };

/** The outcome of one entry of `setMany`. `exists`: an `ifAbsent` entry met a live entry and changed nothing. Rule S7. */
export type WriteOutcome = 'written' | 'exists';

/** The time left on a live entry. Rule S9. */
export type TimeToLive =
  | { readonly state: 'missing' }
  | { readonly state: 'persistent' }
  | { readonly state: 'expiring'; readonly ms: number };

/** The options of one cleanup run. Both are positive safe integers. Rules S10 and S14. */
export interface CleanupOptions {
  /** The most rows that one batch deletes. Default 5,000, at most `maxBatchSize`. */
  readonly batchSize?: number;
  /** The most batches of one run. Default: no limit. */
  readonly maxBatches?: number;
}

/** The result of one cleanup run. Rule S10. */
export interface CleanupResult {
  readonly deleted: number;
  readonly batches: number;
}

/** The finite limits of one store. Each is a positive safe integer. Rule S14. */
export interface Limits {
  /** The largest encoded value, in bytes. Over it: `value_too_large`. */
  readonly maxValueBytes?: number;
  /** The most entries of `getMany`, `setMany` and `deleteMany`, and the largest cleanup `batchSize`. Over it: `batch_too_large`. */
  readonly maxBatchSize?: number;
}

/** The provisional defaults of S14. Issue #7 measures them before release. */
export const DEFAULT_LIMITS: Readonly<Required<Limits>> = Object.freeze({ maxValueBytes: 1_048_576, maxBatchSize: 5_000 });

/** A key-value cache with expiry. Each method rejects with a KvError when the store fails. Rule S12. */
export interface KvStore<V = unknown> {
  /** `{ found: true, value }` for a live entry, else `{ found: false }`. A read never returns an expired entry. Rule S1. */
  get(key: string): Promise<ReadResult<V>>;
  /** One read result for each key, in the order of `keys`. Rule S7. */
  getMany(keys: readonly string[]): Promise<ReadResult<V>[]>;
  /** Insert or replace. Returns false only when `ifAbsent` is set and a live entry exists. Rules S2, S6. */
  set(key: string, value: V, options?: SetOptions): Promise<boolean>;
  /** Writes in one statement, so all commit or none. One outcome for each entry, in input order. Rule S7. */
  setMany(entries: readonly Entry<V>[]): Promise<WriteOutcome[]>;
  /** True when a live entry was deleted. Rule S5. */
  delete(key: string): Promise<boolean>;
  /** The count of live entries deleted. A repeated key counts once. Rule S7. */
  deleteMany(keys: readonly string[]): Promise<number>;
  /** Deletes every entry whose key starts with `prefix`, compared byte by byte. Returns the live count. Rule S8. */
  deletePrefix(prefix: string): Promise<number>;
  /** True when a live entry has the key. Rule S1. */
  has(key: string): Promise<boolean>;
  /** Rule S9. */
  ttl(key: string): Promise<TimeToLive>;
  /** Sets a new expiry on a live entry. False when no live entry has the key. Rules S4, S9. */
  expire(key: string, options: ExpiryOptions): Promise<boolean>;
  /** Removes the expiry of a live entry. False when no live entry has the key. Rule S9. */
  persist(key: string): Promise<boolean>;
  /** Deletes expired entries in batches. Rule S10. */
  cleanupExpired(options?: CleanupOptions): Promise<CleanupResult>;
  /** Stops timers that the store started. It does not close a pool that the caller gave. Rule S11. */
  close(): Promise<void>;
}

/** The kinds of failure that a store reports, in the order of the S12 table. */
export const KV_ERROR_CODES = Object.freeze([
  'invalid_key',
  'invalid_ttl',
  'invalid_value',
  'invalid_batch',
  'value_too_large',
  'batch_too_large',
  'codec',
  'driver',
  'schema',
  'closed',
] as const);

/** The kinds of failure that a store reports. Rule S12. */
export type KvErrorCode = (typeof KV_ERROR_CODES)[number];

/** The one error type of the contract. `cause` keeps the driver or codec error for the caller only (S13). */
export class KvError extends Error {
  readonly code: KvErrorCode;

  constructor(code: KvErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KvError';
    this.code = code;
  }
}
