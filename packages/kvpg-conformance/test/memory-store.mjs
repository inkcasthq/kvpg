// The reference store of the conformance suite: contract v1 in memory (docs/spec-1.0.md R15).
// It is a test subject of the portable suite, not a cache for use, and it is not part of the package.
// It shares no code with the PostgreSQL store apart from the public contract: KvError, the limits and the json codec.
// The option `defect: 'expired-read'` plants one defect for the test of the suite itself: get returns expired entries.
import { DEFAULT_LIMITS, KvError, jsonCodec } from '@inkcasthq/kvpg';

const MAX_KEY_BYTES = 1024;
const DEFAULT_CLEANUP_BATCH = 5_000;
const encoder = new TextEncoder();
const LONE_SURROGATE = /\p{Cs}/u;
const READS = new Set(['get', 'getMany', 'has', 'ttl']);

const utf8 = (text) => encoder.encode(text).byteLength;
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function fail(code, message, cause) {
  throw new KvError(code, `memory store: ${message}`, cause === undefined ? undefined : { cause });
}

/** S3: 1 to 1,024 UTF-8 bytes, without NUL and without a lone surrogate. */
function checkKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0') || LONE_SURROGATE.test(key) || utf8(key) > MAX_KEY_BYTES) {
    fail('invalid_key', 'the key is not a string of 1 to 1,024 UTF-8 bytes without NUL or a lone surrogate');
  }
  return key;
}

/** S4: the expiry time of an options object, or undefined when it has none. */
function expiryOf(options) {
  if (options === undefined) return undefined;
  if (typeof options !== 'object' || options === null) fail('invalid_ttl', 'the expiry options must be an object');
  const { ttlMs, expiresAt } = options;
  if (ttlMs !== undefined && expiresAt !== undefined) fail('invalid_ttl', 'give ttlMs or expiresAt, not both');
  if (ttlMs !== undefined) {
    if (!positive(ttlMs)) fail('invalid_ttl', 'ttlMs must be a positive safe integer');
    return Date.now() + ttlMs;
  }
  if (expiresAt !== undefined) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) fail('invalid_ttl', 'expiresAt must be a valid Date');
    return expiresAt.getTime();
  }
  return undefined;
}

/** A store over one backend: a Map from namespace to a Map from key to `{ stored, expiresAt }`. */
class MemoryStore {
  #backend;
  #namespace;
  #codec;
  #limits;
  #defaultTtlMs;
  #hooks;
  #defect;
  #calls = 0;
  #closed = false;
  #inflight = new Set();

  constructor(backend, config = {}) {
    this.#backend = backend;
    this.#namespace = config.namespace ?? '';
    this.#codec = config.codec ?? jsonCodec;
    this.#limits = { ...DEFAULT_LIMITS, ...config.limits };
    this.#defaultTtlMs = config.defaultTtlMs;
    this.#hooks = config.hooks;
    this.#defect = config.defect;
  }

  get calls() { return this.#calls; }

  get(key) {
    return this.#run('get', 1, () => {
      const checked = checkKey(key);
      const entry = this.#entries().get(checked);
      if (entry === undefined || (this.#defect !== 'expired-read' && !this.#live(entry))) return { found: false };
      return { found: true, value: this.#decode(entry.stored) };
    }, (result) => (result.found ? 1 : 0));
  }

  getMany(keys) {
    return this.#run('getMany', Array.isArray(keys) ? keys.length : undefined, () => {
      const checked = this.#batch(keys).map(checkKey);
      if (checked.length === 0) return [];
      const entries = this.#entries();
      return checked.map((key) => {
        const entry = entries.get(key);
        return entry !== undefined && this.#live(entry) ? { found: true, value: this.#decode(entry.stored) } : { found: false };
      });
    }, (results) => results.filter((result) => result.found).length);
  }

  set(key, value, options) {
    return this.#run('set', 1, () => {
      const checked = checkKey(key);
      const { expiresAt, ifAbsent } = this.#writeOptions(options);
      const stored = this.#encode(value);
      const entries = this.#entries();
      const current = entries.get(checked);
      if (ifAbsent && current !== undefined && this.#live(current)) return false;
      entries.set(checked, { stored, expiresAt });
      return true;
    });
  }

  setMany(items) {
    return this.#run('setMany', Array.isArray(items) ? items.length : undefined, () => {
      const prepared = [];
      const seen = new Set();
      for (const item of this.#batch(items)) {
        if (typeof item !== 'object' || item === null) fail('invalid_key', 'each entry needs a key and a value');
        const key = checkKey(item.key);
        if (seen.has(key)) fail('invalid_batch', 'a key is two or more times in the batch');
        seen.add(key);
        const { expiresAt, ifAbsent } = this.#writeOptions(item.options);
        prepared.push({ key, stored: this.#encode(item.value), expiresAt, ifAbsent });
      }
      if (prepared.length === 0) return [];
      const entries = this.#entries();
      // The checks above are complete before the first write, so the batch writes all entries or none.
      return prepared.map(({ key, stored, expiresAt, ifAbsent }) => {
        const current = entries.get(key);
        if (ifAbsent && current !== undefined && this.#live(current)) return 'exists';
        entries.set(key, { stored, expiresAt });
        return 'written';
      });
    });
  }

  delete(key) {
    return this.#run('delete', 1, () => this.#remove(this.#entries(), checkKey(key)));
  }

  deleteMany(keys) {
    return this.#run('deleteMany', Array.isArray(keys) ? keys.length : undefined, () => {
      const checked = new Set(this.#batch(keys).map(checkKey));
      if (checked.size === 0) return 0;
      const entries = this.#entries();
      let deleted = 0;
      for (const key of checked) if (this.#remove(entries, key)) deleted += 1;
      return deleted;
    });
  }

  deletePrefix(prefix) {
    return this.#run('deletePrefix', undefined, () => {
      const checked = checkKey(prefix);
      const entries = this.#entries();
      let deleted = 0;
      for (const key of [...entries.keys()]) if (key.startsWith(checked) && this.#remove(entries, key)) deleted += 1;
      return deleted;
    });
  }

  has(key) {
    return this.#run('has', 1, () => {
      const checked = checkKey(key);
      const entry = this.#entries().get(checked);
      return entry !== undefined && this.#live(entry);
    }, (live) => (live ? 1 : 0));
  }

  ttl(key) {
    return this.#run('ttl', 1, () => {
      const checked = checkKey(key);
      const entry = this.#entries().get(checked);
      if (entry === undefined || !this.#live(entry)) return { state: 'missing' };
      if (entry.expiresAt === Number.POSITIVE_INFINITY) return { state: 'persistent' };
      return { state: 'expiring', ms: Math.max(0, Math.floor(entry.expiresAt - Date.now())) };
    }, (result) => (result.state === 'missing' ? 0 : 1));
  }

  expire(key, options) {
    return this.#run('expire', 1, () => {
      const checked = checkKey(key);
      const expiresAt = expiryOf(options);
      if (expiresAt === undefined) fail('invalid_ttl', 'expire needs ttlMs or expiresAt');
      const entry = this.#entries().get(checked);
      if (entry === undefined || !this.#live(entry)) return false;
      entry.expiresAt = expiresAt;
      return true;
    });
  }

  persist(key) {
    return this.#run('persist', 1, () => {
      const checked = checkKey(key);
      const entry = this.#entries().get(checked);
      if (entry === undefined || !this.#live(entry)) return false;
      entry.expiresAt = Number.POSITIVE_INFINITY;
      return true;
    });
  }

  cleanupExpired(options) {
    return this.#run('cleanupExpired', undefined, () => {
      if (options !== undefined && (typeof options !== 'object' || options === null)) fail('invalid_batch', 'cleanup options must be an object');
      const batchSize = options?.batchSize ?? Math.min(DEFAULT_CLEANUP_BATCH, this.#limits.maxBatchSize);
      const maxBatches = options?.maxBatches;
      if (!positive(batchSize)) fail('invalid_batch', 'batchSize must be a positive safe integer');
      if (maxBatches !== undefined && !positive(maxBatches)) fail('invalid_batch', 'maxBatches must be a positive safe integer');
      if (batchSize > this.#limits.maxBatchSize) fail('batch_too_large', 'batchSize is over limits.maxBatchSize');
      const entries = this.#entries();
      let deleted = 0;
      let batches = 0;
      while (maxBatches === undefined || batches < maxBatches) {
        const expired = [...entries].filter(([, entry]) => !this.#live(entry)).slice(0, batchSize);
        for (const [key] of expired) entries.delete(key);
        deleted += expired.length;
        batches += 1;
        if (expired.length < batchSize) break;
      }
      return { deleted, batches };
    });
  }

  close() {
    // S11: the work accepted before this call settles first. Close does not wait for itself.
    const accepted = [...this.#inflight];
    return this.#run('close', undefined, () => Promise.allSettled(accepted).then(() => undefined), undefined, () => {
      this.#closed = true;
    });
  }

  /**
   * The pipeline of one operation. The closed check and `accept` run at the call, before the first await (S11).
   * The work runs one turn later, so that a call is asynchronous like a backend call.
   */
  #run(operation, keys, work, hitsOf, accept) {
    const started = performance.now();
    const run = (async () => {
      if (this.#closed) fail('closed', 'the store is closed');
      accept?.();
      await undefined;
      return work();
    })();
    this.#inflight.add(run);
    const settled = run.then(
      (result) => { this.#deliver(operation, keys, started, READS.has(operation) ? hitsOf(result) : undefined, undefined); return result; },
      (error) => { this.#deliver(operation, keys, started, undefined, error.code); throw error; },
    );
    run.then(() => this.#inflight.delete(run), () => this.#inflight.delete(run));
    return settled;
  }

  /** S13: the hook gets safe fields only. A throwing hook gets one notice and never changes the result. */
  #deliver(operation, keys, started, hits, errorCode) {
    const hook = this.#hooks?.onOperation;
    if (typeof hook !== 'function') return;
    const event = { operation, keys: keys ?? 0, durationMs: performance.now() - started };
    if (hits !== undefined) event.hits = hits;
    if (errorCode !== undefined) event.errorCode = errorCode;
    try {
      hook.call(this.#hooks, Object.freeze(event));
    } catch {
      try {
        this.#hooks.onHookError?.(Object.freeze({ code: 'hook' }));
      } catch {
        // A failing notice handler is dropped: it never changes the result and never calls itself again.
      }
    }
  }

  /** The entries of this namespace. Each call is one backend call, counted for the rules that forbid a call. */
  #entries() {
    this.#calls += 1;
    let entries = this.#backend.get(this.#namespace);
    if (entries === undefined) {
      entries = new Map();
      this.#backend.set(this.#namespace, entries);
    }
    return entries;
  }

  #live(entry) {
    return entry.expiresAt > Date.now();
  }

  /** Deletes one entry and returns true when it was live (S5). */
  #remove(entries, key) {
    const entry = entries.get(key);
    if (entry === undefined) return false;
    entries.delete(key);
    return this.#live(entry);
  }

  #batch(items) {
    if (!Array.isArray(items)) fail('invalid_batch', 'the batch must be an array');
    if (items.length > this.#limits.maxBatchSize) fail('batch_too_large', 'the batch is over limits.maxBatchSize');
    return items;
  }

  #writeOptions(options) {
    const expiresAt = expiryOf(options);
    const ifAbsent = options?.ifAbsent;
    if (ifAbsent !== undefined && typeof ifAbsent !== 'boolean') fail('invalid_ttl', 'ifAbsent must be a boolean');
    if (expiresAt !== undefined) return { expiresAt, ifAbsent: ifAbsent === true };
    const fallback = this.#defaultTtlMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + this.#defaultTtlMs;
    return { expiresAt: fallback, ifAbsent: ifAbsent === true };
  }

  #encode(value) {
    let stored;
    try {
      stored = this.#codec.encode(value);
    } catch (error) {
      fail('invalid_value', 'the codec refused the value', error);
    }
    let size;
    if (stored instanceof Uint8Array) size = stored.byteLength;
    else if (typeof stored === 'string') size = utf8(stored);
    else fail('codec', 'the codec must encode to a Uint8Array or a string');
    if (size > this.#limits.maxValueBytes) fail('value_too_large', 'the encoded value is over limits.maxValueBytes');
    return stored;
  }

  #decode(stored) {
    try {
      return this.#codec.decode(stored);
    } catch (error) {
      return fail('codec', 'the codec could not decode a stored value', error);
    }
  }
}

/** The subject of one store on `backend`, with the controls of the suite. */
function subjectOf(backend, config, defect) {
  const store = new MemoryStore(backend, { ...config, defect });
  return {
    store,
    queryCount: () => store.calls,
    async dispose() {
      await store.close().catch((error) => {
        if (error.code !== 'closed') throw error;
      });
    },
    async sibling(siblingConfig) {
      return subjectOf(backend, siblingConfig, defect);
    },
  };
}

/** The factory of the suite: each call makes a new, empty backend. `defect` plants the defect named above. */
export function memorySubjects(defect) {
  return async (config) => subjectOf(new Map(), config, defect);
}
