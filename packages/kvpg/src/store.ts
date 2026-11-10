/**
 * The PostgreSQL store of issue #2 (docs/spec-1.0.md R03 to R16).
 * Each public operation runs one pipeline: telemetry start, closed check, input and encoding, one SQL statement
 * (one for each cleanup batch), decoding, telemetry finish, hook, then the result or one KvError.
 */
import { jsonCodec } from './codec.js';
import { DEFAULT_LIMITS, KvError } from './contract.js';
import type {
  CleanupOptions, CleanupResult, Entry, ExpiryOptions, KvErrorCode, Limits, ReadResult, SetOptions, TimeToLive, WriteOutcome,
} from './contract.js';
import type { CleanupPolicy, Codec, Hooks, Operation, PostgresStore, Queryable, StoreOptions, TableOptions, ValueColumn } from './extension.js';
import { checkKey, frame, isValidNamespace, prefixUpperBound, utf8Length } from './keys.js';
import { cronScheduleSql, statements } from './sql.js';
import type { Statements } from './sql.js';
import { ENVIRONMENT_SWITCH, Observation, resolveSwitches } from './telemetry.js';
import type { Counts, TelemetrySwitches, Trigger } from './telemetry.js';

const DEFAULT_CLEANUP_BATCH = 5_000;
/** The largest delay of a Node.js timer. */
const MAX_TIMER_MS = 2_147_483_647;
const MAX_IDENTIFIER_BYTES = 63;
const VALUE_COLUMNS: readonly ValueColumn[] = ['bytea', 'text', 'jsonb'];

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function fail(code: KvErrorCode, message: string, cause?: unknown): never {
  throw new KvError(code, `kvpg: ${message}`, cause === undefined ? undefined : { cause });
}

/** A failure that is not a KvError comes from the driver (S12). The caller keeps it as the cause. */
function asKvError(error: unknown): KvError {
  return error instanceof KvError ? error : new KvError('driver', 'kvpg: the database call failed', { cause: error });
}

interface WriteExpiry {
  readonly expiresAt: Date | null;
  readonly ttlMs: number | null;
}

/** Progress of one operation, for its telemetry and hooks. */
class Progress {
  readonly counts: Counts = {};
  constructor(readonly observation: Observation | undefined) {}
  confirmedBatch(rows: number): void {
    this.counts.rowsDeleted = (this.counts.rowsDeleted ?? 0) + rows;
    this.counts.batches = (this.counts.batches ?? 0) + 1;
    this.observation?.confirmedRows(rows);
  }
}

function checkTable(table: TableOptions | undefined): Required<TableOptions> {
  if (table !== undefined && (typeof table !== 'object' || table === null)) throw new TypeError('kvpg: table must be an object');
  const { schema = 'public', table: name = 'kvpg_entries', unlogged = false, fillfactor = 70 } = table ?? {};
  for (const [label, identifier] of [['table.schema', schema], ['table.table', name]] as const) {
    if (typeof identifier !== 'string' || identifier.length === 0 || identifier.includes('\0') || utf8Length(identifier) > MAX_IDENTIFIER_BYTES) {
      throw new RangeError(`kvpg: ${label} must be a PostgreSQL identifier of 1 to 63 bytes without NUL`);
    }
  }
  if (typeof unlogged !== 'boolean') throw new TypeError('kvpg: table.unlogged must be a boolean');
  if (!Number.isInteger(fillfactor) || fillfactor < 10 || fillfactor > 100) throw new RangeError('kvpg: table.fillfactor must be an integer from 10 to 100');
  return { schema, table: name, unlogged, fillfactor };
}

function checkCodec<V>(codec: Codec<V> | undefined): Codec<V> {
  if (codec === undefined) return jsonCodec as Codec<V>;
  if (typeof codec !== 'object' || codec === null || typeof codec.name !== 'string' || !VALUE_COLUMNS.includes(codec.column)
    || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
    throw new TypeError('kvpg: codec needs a name, a column of bytea, text or jsonb, encode and decode');
  }
  return codec;
}

function checkHooks(hooks: Hooks | undefined): Hooks | undefined {
  if (hooks === undefined) return undefined;
  if (typeof hooks !== 'object' || hooks === null) throw new TypeError('kvpg: hooks must be an object');
  for (const name of ['onOperation', 'onHookError'] as const) {
    if (hooks[name] !== undefined && typeof hooks[name] !== 'function') throw new TypeError(`kvpg: hooks.${name} must be a function`);
  }
  return hooks.onOperation === undefined ? undefined : hooks;
}

function checkLimits(limits: Limits | undefined): Required<Limits> {
  if (limits !== undefined && (typeof limits !== 'object' || limits === null)) throw new TypeError('kvpg: limits must be an object');
  const resolved = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(limits ?? {}).filter(([, value]) => value !== undefined)) };
  for (const name of ['maxValueBytes', 'maxBatchSize'] as const) {
    if (!isPositiveSafeInteger(resolved[name])) throw new RangeError(`kvpg: limits.${name} must be a positive safe integer`);
  }
  return resolved;
}

type ResolvedPolicy =
  | { readonly kind: 'manual' }
  | { readonly kind: 'interval'; readonly everyMs: number; readonly batchSize: number }
  | { readonly kind: 'pg_cron'; readonly schedule: string; readonly batchSize: number };

function checkPolicy(policy: CleanupPolicy | undefined, maxBatchSize: number): ResolvedPolicy {
  if (policy === undefined) return { kind: 'manual' };
  if (typeof policy !== 'object' || policy === null) throw new TypeError('kvpg: cleanup must be an object');
  if (policy.kind === 'manual') return { kind: 'manual' };
  const batchSize = policy.batchSize ?? Math.min(DEFAULT_CLEANUP_BATCH, maxBatchSize);
  if (!isPositiveSafeInteger(batchSize) || batchSize > maxBatchSize) {
    throw new RangeError('kvpg: cleanup.batchSize must be a positive safe integer at most limits.maxBatchSize');
  }
  if (policy.kind === 'interval') {
    if (!isPositiveSafeInteger(policy.everyMs) || policy.everyMs > MAX_TIMER_MS) {
      throw new RangeError('kvpg: cleanup.everyMs must be a positive integer of at most 2147483647');
    }
    return { kind: 'interval', everyMs: policy.everyMs, batchSize };
  }
  if (policy.kind === 'pg_cron') {
    if (typeof policy.schedule !== 'string' || policy.schedule.trim() === '' || policy.schedule.includes('\0')) {
      throw new RangeError('kvpg: cleanup.schedule must be a pg_cron schedule');
    }
    return { kind: 'pg_cron', schedule: policy.schedule, batchSize };
  }
  throw new RangeError('kvpg: cleanup.kind must be manual, interval or pg_cron');
}

class PostgresKvStore<V> implements PostgresStore<V> {
  readonly #db: Queryable;
  readonly #codec: Codec<V>;
  readonly #hooks: Hooks | undefined;
  readonly #switches: TelemetrySwitches;
  readonly #sql: Statements;
  readonly #column: ValueColumn;
  readonly #frame: string;
  readonly #frameEnd: string;
  readonly #limits: Required<Limits>;
  readonly #defaultTtlMs: number | null;
  readonly #policy: ResolvedPolicy;
  readonly #inflight = new Set<Promise<unknown>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #ticking = false;
  #intervalFailures = 0;

  constructor(options: StoreOptions<V>) {
    if (typeof options !== 'object' || options === null) throw new TypeError('kvpg: createStore needs an options object');
    if (typeof options.db?.query !== 'function') throw new TypeError('kvpg: db must have a query(text, values) method');
    this.#db = options.db;
    this.#codec = checkCodec(options.codec);
    this.#column = this.#codec.column;
    this.#hooks = checkHooks(options.hooks);
    const namespace = options.namespace ?? '';
    if (!isValidNamespace(namespace)) throw new RangeError('kvpg: namespace must follow the key rules of S3, or be empty');
    this.#frame = frame(namespace);
    // A frame starts with an ASCII digit, so it always has an upper bound.
    this.#frameEnd = prefixUpperBound(this.#frame) as string;
    if (options.defaultTtlMs !== undefined && !isPositiveSafeInteger(options.defaultTtlMs)) {
      throw new RangeError('kvpg: defaultTtlMs must be a positive safe integer');
    }
    this.#defaultTtlMs = options.defaultTtlMs ?? null;
    this.#limits = checkLimits(options.limits);
    this.#policy = checkPolicy(options.cleanup, this.#limits.maxBatchSize);
    this.#switches = resolveSwitches(options.telemetry, process.env[ENVIRONMENT_SWITCH]);
    this.#sql = statements({ ...checkTable(options.table), column: this.#column });
    if (this.#policy.kind === 'interval') {
      // The callback returns the promise of the run, which never rejects. The timer does not keep the process alive.
      this.#timer = setInterval(() => this.#tick(), this.#policy.everyMs);
      this.#timer.unref?.();
    }
  }

  get(key: string): Promise<ReadResult<V>> {
    return this.#track('get', 1, async () => {
      const stored = this.#stored(key);
      const { rows } = await this.#db.query<{ value: Uint8Array | string }>(this.#sql.get, [stored]);
      const row = rows[0];
      return row === undefined ? { found: false } : { found: true, value: this.#decode(row.value) };
    }, (result) => (result.found ? { hits: 1, misses: 0 } : { hits: 0, misses: 1 }));
  }

  getMany(keys: readonly string[]): Promise<ReadResult<V>[]> {
    return this.#track('getMany', Array.isArray(keys) ? keys.length : undefined, async () => {
      const stored = this.#batchKeys(keys);
      if (stored.length === 0) return [];
      const unique = [...new Set(stored)];
      const { rows } = await this.#db.query<{ key: string; value: Uint8Array | string }>(this.#sql.getMany, [unique]);
      const values = new Map<string, V>();
      for (const row of rows) values.set(row.key, this.#decode(row.value));
      return stored.map((item): ReadResult<V> => (values.has(item) ? { found: true, value: values.get(item) as V } : { found: false }));
    }, (results) => {
      const hits = results.filter((result) => result.found).length;
      return { hits, misses: results.length - hits };
    });
  }

  set(key: string, value: V, options?: SetOptions): Promise<boolean> {
    return this.#track('set', 1, async () => {
      const stored = this.#stored(key);
      const { expiry, ifAbsent } = this.#writeOptions(options);
      const encoded = this.#encode(value);
      const { rows } = await this.#db.query(ifAbsent ? this.#sql.setIfAbsent : this.#sql.set, [stored, encoded, expiry.expiresAt, expiry.ttlMs]);
      return rows.length > 0;
    });
  }

  setMany(entries: readonly Entry<V>[]): Promise<WriteOutcome[]> {
    return this.#track('setMany', Array.isArray(entries) ? entries.length : undefined, async () => {
      this.#batchSize(entries);
      const keys: string[] = [];
      const values: Array<Uint8Array | string> = [];
      const expiresAt: Array<Date | null> = [];
      const ttlMs: Array<number | null> = [];
      const ifAbsent: boolean[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) fail('invalid_key', 'each entry needs a key and a value');
        const stored = this.#stored(entry.key);
        if (seen.has(stored)) fail('invalid_batch', 'a key is two or more times in the batch');
        seen.add(stored);
        const options = this.#writeOptions(entry.options);
        keys.push(stored);
        values.push(this.#encode(entry.value));
        expiresAt.push(options.expiry.expiresAt);
        ttlMs.push(options.expiry.ttlMs);
        ifAbsent.push(options.ifAbsent);
      }
      if (keys.length === 0) return [];
      const { rows } = await this.#db.query<{ key: string }>(this.#sql.setMany, [keys, values, expiresAt, ttlMs, ifAbsent]);
      const written = new Set(rows.map((row) => row.key));
      return keys.map((item): WriteOutcome => (written.has(item) ? 'written' : 'exists'));
    });
  }

  delete(key: string): Promise<boolean> {
    return this.#track('delete', 1, async () => {
      const { rows } = await this.#db.query<{ live: boolean }>(this.#sql.delete, [this.#stored(key)]);
      return rows[0]?.live === true;
    });
  }

  deleteMany(keys: readonly string[]): Promise<number> {
    return this.#track('deleteMany', Array.isArray(keys) ? keys.length : undefined, async () => {
      const stored = this.#batchKeys(keys);
      if (stored.length === 0) return 0;
      const { rows } = await this.#db.query<{ deleted: number }>(this.#sql.deleteMany, [[...new Set(stored)]]);
      return Number(rows[0]?.deleted ?? 0);
    });
  }

  deletePrefix(prefix: string): Promise<number> {
    return this.#track('deletePrefix', undefined, async () => {
      const lower = this.#stored(prefix);
      // The framed prefix starts with an ASCII digit, so it always has an upper bound.
      const upper = prefixUpperBound(lower) as string;
      const { rows } = await this.#db.query<{ deleted: number }>(this.#sql.deleteRange, [lower, upper]);
      return Number(rows[0]?.deleted ?? 0);
    });
  }

  has(key: string): Promise<boolean> {
    return this.#track('has', 1, async () => {
      const { rows } = await this.#db.query<{ live: boolean }>(this.#sql.has, [this.#stored(key)]);
      return rows[0]?.live === true;
    }, (live) => (live ? { hits: 1, misses: 0 } : { hits: 0, misses: 1 }));
  }

  ttl(key: string): Promise<TimeToLive> {
    return this.#track('ttl', 1, async (): Promise<TimeToLive> => {
      const { rows } = await this.#db.query<{ ms: number | string | null }>(this.#sql.ttl, [this.#stored(key)]);
      const row = rows[0];
      if (row === undefined) return { state: 'missing' };
      if (row.ms === null) return { state: 'persistent' };
      return { state: 'expiring', ms: Math.max(0, Number(row.ms)) };
    }, (result) => (result.state === 'missing' ? { hits: 0, misses: 1 } : { hits: 1, misses: 0 }));
  }

  expire(key: string, options: ExpiryOptions): Promise<boolean> {
    return this.#track('expire', 1, async () => {
      const stored = this.#stored(key);
      const expiry = this.#expiry(options);
      // RF22: expire needs an expiry. Without one, the default of a write does not apply.
      if (expiry.expiresAt === null && expiry.ttlMs === null) fail('invalid_ttl', 'expire needs ttlMs or expiresAt');
      const { rows } = await this.#db.query(this.#sql.expire, [stored, expiry.expiresAt, expiry.ttlMs]);
      return rows.length > 0;
    });
  }

  persist(key: string): Promise<boolean> {
    return this.#track('persist', 1, async () => {
      const { rows } = await this.#db.query(this.#sql.persist, [this.#stored(key)]);
      return rows.length > 0;
    });
  }

  cleanupExpired(options?: CleanupOptions): Promise<CleanupResult> {
    return this.#track('cleanupExpired', undefined, (progress) => this.#cleanup(options, progress));
  }

  close(): Promise<void> {
    return this.#track('close', undefined, async () => {
      // S11: from here every new call rejects with `closed`. Accepted work settles first.
      this.#closed = true;
      if (this.#timer !== undefined) clearInterval(this.#timer);
      this.#timer = undefined;
      await Promise.allSettled([...this.#inflight]);
    });
  }

  schemaSql(): Promise<string> {
    return this.#track('schemaSql', undefined, async () => this.#schemaText());
  }

  migrate(): Promise<void> {
    return this.#track('migrate', undefined, async () => {
      await this.#db.query(this.#schemaText());
      const { rows } = await this.#db.query<{ name: string; type: string; collation: string | null }>(this.#sql.columns, [this.#sql.qualified]);
      const columns = new Map(rows.map((row) => [row.name, row]));
      const fits = columns.get('key')?.type === 'text' && columns.get('key')?.collation === 'C'
        && columns.get('value')?.type === this.#column
        && columns.get('expires_at')?.type === 'timestamp with time zone';
      if (!fits) fail('schema', `the table does not have the columns key text COLLATE "C", value ${this.#column} and expires_at timestamptz`);
    });
  }

  /** The DDL, and the pg_cron schedule of the cleanup policy (R04, R10). Internal, so migrate adds no second span. */
  #schemaText(): string {
    if (this.#policy.kind !== 'pg_cron') return this.#sql.ddl;
    return `${this.#sql.ddl}\n${cronScheduleSql(this.#sql.qualified, this.#frame, this.#frameEnd, this.#policy.batchSize, this.#policy.schedule)}`;
  }

  async #cleanup(options: CleanupOptions | undefined, progress: Progress): Promise<CleanupResult> {
    if (options !== undefined && (typeof options !== 'object' || options === null)) fail('invalid_batch', 'cleanup options must be an object');
    const batchSize = options?.batchSize ?? Math.min(DEFAULT_CLEANUP_BATCH, this.#limits.maxBatchSize);
    const maxBatches = options?.maxBatches;
    if (!isPositiveSafeInteger(batchSize)) fail('invalid_batch', 'batchSize must be a positive safe integer');
    if (maxBatches !== undefined && !isPositiveSafeInteger(maxBatches)) fail('invalid_batch', 'maxBatches must be a positive safe integer');
    if (batchSize > this.#limits.maxBatchSize) fail('batch_too_large', 'batchSize is over limits.maxBatchSize');
    let deleted = 0;
    let batches = 0;
    while (maxBatches === undefined || batches < maxBatches) {
      const { rows } = await this.#db.query<{ deleted: number }>(this.#sql.cleanupBatch, [this.#frame, this.#frameEnd, batchSize]);
      const rowsDeleted = Number(rows[0]?.deleted ?? 0);
      deleted += rowsDeleted;
      batches += 1;
      progress.confirmedBatch(rowsDeleted);
      if (rowsDeleted < batchSize) break;
    }
    return { deleted, batches };
  }

  /** The interval callback (R10, T06): skips a run while one is active and does nothing after close. */
  #tick(): Promise<void> {
    if (this.#closed || this.#ticking || this.#policy.kind !== 'interval') return Promise.resolve();
    this.#ticking = true;
    const { batchSize } = this.#policy;
    return this.#track('cleanupExpired', undefined, (progress) => this.#cleanup({ batchSize }, progress), undefined, 'interval')
      .then(() => undefined, () => undefined)
      .finally(() => { this.#ticking = false; });
  }

  /** Runs one public operation through the pipeline and keeps it in the in-flight set until it settles (S11). */
  #track<T>(operation: Operation, keys: number | undefined, work: (progress: Progress) => Promise<T>,
    counts?: (result: T) => Counts, trigger: Trigger = 'foreground'): Promise<T> {
    const run = this.#run(operation, trigger, keys, work, counts);
    this.#inflight.add(run);
    const remove = () => { this.#inflight.delete(run); };
    run.then(remove, remove);
    return run;
  }

  async #run<T>(operation: Operation, trigger: Trigger, keys: number | undefined, work: (progress: Progress) => Promise<T>,
    counts: ((result: T) => Counts) | undefined): Promise<T> {
    const observation = Observation.start(operation, trigger, this.#switches, this.#hooks);
    const progress = new Progress(observation);
    let result: T;
    try {
      if (this.#closed) fail('closed', 'the store is closed');
      result = observation === undefined ? await work(progress) : await observation.within(() => work(progress));
    } catch (error) {
      const failure = asKvError(error);
      if (trigger === 'interval') this.#intervalFailures += 1;
      observation?.finish('error', failure.code, keys, progress.counts, false);
      throw failure;
    }
    let recovered = false;
    if (trigger === 'interval') {
      recovered = this.#intervalFailures > 0;
      this.#intervalFailures = 0;
    }
    if (observation !== undefined) {
      const summary = counts === undefined ? progress.counts : { ...progress.counts, ...counts(result) };
      observation.finish('success', undefined, keys, summary, recovered);
    }
    return result;
  }

  #stored(key: unknown): string {
    return this.#frame + checkKey(key);
  }

  #batchSize(items: unknown): asserts items is readonly unknown[] {
    if (!Array.isArray(items)) fail('invalid_batch', 'the batch must be an array');
    if (items.length > this.#limits.maxBatchSize) fail('batch_too_large', 'the batch is over limits.maxBatchSize');
  }

  #batchKeys(keys: unknown): string[] {
    this.#batchSize(keys);
    return keys.map((key) => this.#stored(key));
  }

  /** The expiry of a write or of expire (S4). Any refused option gives `invalid_ttl`. */
  #expiry(options: unknown): WriteExpiry {
    if (options === undefined) return { expiresAt: null, ttlMs: null };
    if (typeof options !== 'object' || options === null) fail('invalid_ttl', 'the expiry options must be an object');
    const { ttlMs, expiresAt } = options as ExpiryOptions;
    if (ttlMs !== undefined && expiresAt !== undefined) fail('invalid_ttl', 'give ttlMs or expiresAt, not both');
    if (ttlMs !== undefined && !isPositiveSafeInteger(ttlMs)) fail('invalid_ttl', 'ttlMs must be a positive safe integer');
    if (expiresAt !== undefined && !(expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime()))) fail('invalid_ttl', 'expiresAt must be a valid Date');
    return { expiresAt: expiresAt ?? null, ttlMs: ttlMs ?? null };
  }

  /** The options of a write (S4, S6, RF24). Without an expiry, the store default applies. */
  #writeOptions(options: unknown): { expiry: WriteExpiry; ifAbsent: boolean } {
    const expiry = this.#expiry(options);
    const ifAbsent = (options as SetOptions | undefined)?.ifAbsent;
    if (ifAbsent !== undefined && typeof ifAbsent !== 'boolean') fail('invalid_ttl', 'ifAbsent must be a boolean');
    const resolved = expiry.expiresAt === null && expiry.ttlMs === null ? { expiresAt: null, ttlMs: this.#defaultTtlMs } : expiry;
    return { expiry: resolved, ifAbsent: ifAbsent === true };
  }

  #encode(value: V): Uint8Array | string {
    let encoded: Uint8Array | string;
    try {
      encoded = this.#codec.encode(value);
    } catch (error) {
      fail('invalid_value', 'the codec refused the value', error);
    }
    const binary = this.#column === 'bytea';
    if (binary ? !(encoded instanceof Uint8Array) : typeof encoded !== 'string') {
      fail('codec', `the codec must encode to ${binary ? 'a Uint8Array' : 'a string'} for a ${this.#column} column`);
    }
    const size = typeof encoded === 'string' ? utf8Length(encoded) : encoded.byteLength;
    if (size > this.#limits.maxValueBytes) fail('value_too_large', 'the encoded value is over limits.maxValueBytes');
    return encoded;
  }

  #decode(stored: Uint8Array | string): V {
    try {
      return this.#codec.decode(stored);
    } catch (error) {
      return fail('codec', 'the codec could not decode a stored value', error);
    }
  }
}

/**
 * Creates a PostgreSQL store. It makes no database call: run `migrate()` or apply `schemaSql()` first.
 * An invalid configuration throws a TypeError or a RangeError (RF11).
 */
export function createStore<V = unknown>(options: StoreOptions<V>): PostgresStore<V> {
  return new PostgresKvStore<V>(options);
}
