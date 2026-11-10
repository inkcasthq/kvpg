// The conformance suite of the kvpg cache contract, version 1 (docs/standard.md S1 to S14, "Values").
// Each test is named by its rule, so a failure names the rule that the store breaks.
// The suite uses the public operations only. Expired entries come from a past `expiresAt` (S4), not from sleeps.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { KV_ERROR_CODES } from '@inkcasthq/kvpg';

const PAST = () => new Date(Date.now() - 3_600_000);
const HOUR = 3_600_000;
const HIT = (value) => ({ found: true, value });
const MISS = Object.freeze({ found: false });

/** Rejects unless `promise` rejects with one KvError of `code`. Returns the error. */
export async function rejectsWith(promise, code) {
  let caught;
  await assert.rejects(promise, (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught?.name, 'KvError', `expected a KvError with code ${code}, got ${caught?.name}`);
  assert.ok(KV_ERROR_CODES.includes(caught.code), `unknown error code ${caught.code}`);
  assert.equal(caught.code, code);
  return caught;
}

/** A json codec over text, with a switch to fail encode or decode. Its domain also holds `undefined`. */
export function controlledCodec(column = 'bytea') {
  const state = { failEncode: undefined, failDecode: undefined };
  const toText = (value) => (value === undefined ? '"\u0000undefined"' : JSON.stringify(value));
  const fromText = (text) => (text === '"\u0000undefined"' ? undefined : JSON.parse(text));
  return {
    state,
    codec: {
      name: 'conformance-controlled', column,
      encode(value) {
        if (state.failEncode) throw state.failEncode;
        return column === 'bytea' ? new TextEncoder().encode(toText(value)) : toText(value);
      },
      decode(stored) {
        if (state.failDecode) throw state.failDecode;
        return fromText(typeof stored === 'string' ? stored : new TextDecoder().decode(stored));
      },
    },
  };
}

/**
 * Registers the suite for one store.
 * `makeSubject(config)` returns `{ store, dispose(), queryCount?(), sibling?(config) }` for a new, empty backend.
 * `config` holds `namespace`, `limits`, `defaultTtlMs`, `codec` and `hooks`, each optional.
 * `sibling(config)` returns another store on the same backend, for namespace isolation and S11.
 * `queryCount()` returns the backend calls so far, for the rules that forbid a call.
 */
export function conformance(name, makeSubject, options = {}) {
  assert.equal(typeof makeSubject, 'function', 'conformance needs a subject factory');
  const pending = options.pending ?? false;

  // The test of each subject, so that a check that cannot run says so in the report of that test.
  const owners = new WeakMap();
  describe(`${name} conformance (kvpg contract v1)`, { concurrency: false }, () => {
    const rule = (title, body) => test(title, { skip: pending, timeout: 20_000 }, async (t) => {
      const subjects = [];
      const open = async (config = {}) => {
        const subject = await makeSubject(config);
        assert.ok(subject?.store, 'the factory must return a store');
        owners.set(subject, { t, noted: false });
        subjects.push(subject);
        return subject;
      };
      try {
        await body({ open, t });
      } finally {
        for (const subject of subjects.reverse()) await subject.dispose();
      }
    });
    const noCall = async (subject, action) => {
      if (typeof subject.queryCount !== 'function') {
        const owner = owners.get(subject);
        if (owner && !owner.noted) owner.t.diagnostic('queryCount() is missing: the no-call checks of this rule did not run');
        if (owner) owner.noted = true;
        return action();
      }
      const before = subject.queryCount();
      const result = await action();
      assert.equal(subject.queryCount(), before, 'the operation must make no backend call');
      return result;
    };

    rule('S1 a read never returns an expired entry, and a read result is tagged', async ({ open }) => {
      const { store } = await open();
      assert.equal(await store.set('live', { n: 1 }), true);
      assert.equal(await store.set('old', 'v', { expiresAt: PAST() }), true);
      assert.deepEqual(await store.get('live'), HIT({ n: 1 }));
      assert.deepEqual(await store.get('old'), MISS);
      assert.deepEqual(await store.get('absent'), MISS);
      assert.deepEqual(await store.getMany(['old', 'live', 'absent']), [MISS, HIT({ n: 1 }), MISS]);
      assert.equal(await store.has('old'), false);
      assert.deepEqual(await store.ttl('old'), { state: 'missing' });
    });
    rule('S1 a stored null is a hit, and a stored undefined is { found: true, value: undefined }', async ({ open }) => {
      const { store } = await open();
      await store.set('null', null);
      assert.deepEqual(await store.get('null'), HIT(null));
      const { codec } = controlledCodec();
      const custom = (await open({ codec })).store;
      await custom.set('undefined', undefined);
      const result = await custom.get('undefined');
      assert.equal(result.found, true);
      assert.ok(Object.hasOwn(result, 'value') && result.value === undefined);
    });
    rule('S2 set replaces the value and the expiry of a live or expired entry, and returns true', async ({ open }) => {
      const { store } = await open();
      assert.equal(await store.set('k', 1, { ttlMs: HOUR }), true);
      assert.equal(await store.set('k', 2), true);
      assert.deepEqual(await store.get('k'), HIT(2));
      assert.deepEqual(await store.ttl('k'), { state: 'persistent' });
      assert.equal(await store.set('k', 3, { ttlMs: HOUR }), true);
      assert.equal((await store.ttl('k')).state, 'expiring');
      await store.set('e', 1, { expiresAt: PAST() });
      assert.equal(await store.set('e', 2), true);
      assert.deepEqual(await store.get('e'), HIT(2));
    });
    rule('S3 a key is 1 to 1,024 UTF-8 bytes, without NUL or a lone surrogate, compared byte by byte', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      for (const key of ['', 'a'.repeat(1025), 'a\0b', 'a\ud800', '\udc00', 'é'.repeat(512) + 'a', 7, undefined]) {
        await noCall(subject, () => rejectsWith(store.get(key), 'invalid_key'));
        await noCall(subject, () => rejectsWith(store.set(key, 1), 'invalid_key'));
      }
      for (const key of ['a'.repeat(1024), 'é'.repeat(512), '😀'.repeat(256), "'); DROP TABLE x; --", '%_\\', 'Key']) {
        assert.equal(await store.set(key, key), true);
        assert.deepEqual(await store.get(key), HIT(key));
      }
      assert.deepEqual(await store.get('key'), MISS, 'case is not folded');
      await store.set('é', 'composed');
      assert.deepEqual(await store.get('é'), MISS, 'Unicode is not normalized');
    });
    rule('S4 ttlMs is a positive safe integer, expiresAt a valid Date, never both', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      for (const options of [{ ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: 1.5 }, { ttlMs: Number.NaN }, { ttlMs: Number.POSITIVE_INFINITY },
        { ttlMs: 2 ** 53 }, { ttlMs: '5' }, { expiresAt: new Date(Number.NaN) }, { expiresAt: '2026-01-01' },
        { ttlMs: 1000, expiresAt: new Date() }, 'soon']) {
        await noCall(subject, () => rejectsWith(store.set('k', 1, options), 'invalid_ttl'));
      }
      // The largest ttlMs either fails with one KvError or writes an expiring entry, never a silent persistent one (R06).
      const largest = await store.set('max', 1, { ttlMs: Number.MAX_SAFE_INTEGER }).then(() => undefined, (error) => error);
      if (largest === undefined) assert.equal((await store.ttl('max')).state, 'expiring');
      else assert.ok(['driver', 'invalid_ttl'].includes(largest.code), `unexpected code ${largest.code}`);
      await store.set('past', 1, { expiresAt: PAST() });
      assert.deepEqual(await store.get('past'), MISS, 'a past date makes the entry expired at once');
      await store.set('soon', 1, { ttlMs: 50 });
      assert.deepEqual(await store.get('soon'), HIT(1));
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(await store.get('soon'), MISS);
      const defaults = (await open({ defaultTtlMs: HOUR })).store;
      await defaults.set('d', 1);
      const left = await defaults.ttl('d');
      assert.equal(left.state, 'expiring');
      assert.ok(left.ms > HOUR - 60_000 && left.ms <= HOUR);
    });
    rule('S5 delete returns true for a live entry and false for an expired or missing one', async ({ open }) => {
      const { store } = await open();
      await store.set('live', 1);
      await store.set('old', 1, { expiresAt: PAST() });
      assert.equal(await store.delete('live'), true);
      assert.equal(await store.delete('live'), false);
      assert.equal(await store.delete('old'), false);
      assert.equal(await store.delete('absent'), false);
      assert.equal(await store.set('old', 2, { ifAbsent: true }), true);
    });
    rule('S6 ifAbsent keeps a live entry and replaces an expired one, and one of two racing writes wins', async ({ open }) => {
      const { store } = await open();
      await store.set('live', 'first');
      assert.equal(await store.set('live', 'second', { ifAbsent: true }), false);
      assert.deepEqual(await store.get('live'), HIT('first'));
      await store.set('old', 'first', { expiresAt: PAST() });
      assert.equal(await store.set('old', 'second', { ifAbsent: true }), true);
      assert.deepEqual(await store.get('old'), HIT('second'));
      const results = await Promise.all([store.set('race', 'a', { ifAbsent: true }), store.set('race', 'b', { ifAbsent: true })]);
      assert.deepEqual(results.filter(Boolean).length, 1);
      assert.deepEqual(await store.get('race'), HIT(results[0] ? 'a' : 'b'));
    });
    rule('S7 getMany gives one result for each key in order, repeats included', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      await store.set('a', 1);
      await store.set('old', 1, { expiresAt: PAST() });
      assert.deepEqual(await store.getMany(['a', 'b', 'a', 'old']), [HIT(1), MISS, HIT(1), MISS]);
      assert.deepEqual(await noCall(subject, () => store.getMany([])), []);
      await noCall(subject, () => rejectsWith(store.getMany(['a', '']), 'invalid_key'));
      for (const keys of [new Array(1), ['a', , 'a']]) {
        await noCall(subject, () => rejectsWith(store.getMany(keys), 'invalid_key'));
      }
      assert.deepEqual(await store.getMany(['a', 'a']), [HIT(1), HIT(1)], 'a dense batch still works after refusal');
    });
    rule('S7 setMany returns written or exists for each entry and writes all entries or none', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      await store.set('live', 'kept');
      await store.set('old', 'gone', { expiresAt: PAST() });
      const outcomes = await store.setMany([
        { key: 'live', value: 'x', options: { ifAbsent: true } },
        { key: 'old', value: 'y', options: { ifAbsent: true } },
        { key: 'new', value: 'z', options: { ttlMs: HOUR } },
        { key: 'plain', value: 'w' },
      ]);
      assert.deepEqual(outcomes, ['exists', 'written', 'written', 'written']);
      assert.deepEqual(await store.getMany(['live', 'old', 'new', 'plain']), [HIT('kept'), HIT('y'), HIT('z'), HIT('w')]);
      assert.deepEqual(await noCall(subject, () => store.setMany([])), []);
      await noCall(subject, () => rejectsWith(store.setMany([{ key: 'a', value: 1 }, { key: 'b', value: 2 }, { key: 'a', value: 3 }]), 'invalid_batch'));
      await noCall(subject, () => rejectsWith(store.setMany([{ key: 'c', value: 1 }, { key: 'd', value: 1, options: { ttlMs: 0 } }]), 'invalid_ttl'));
      await noCall(subject, () => rejectsWith(store.setMany('a'), 'invalid_batch'));
      assert.deepEqual(await store.getMany(['a', 'b', 'c']), [MISS, MISS, MISS], 'a refused batch writes nothing');
      assert.deepEqual(await store.setMany([{ key: 'a', value: 1 }]), ['written'], 'a valid batch after a refusal works');
    });
    rule('S7 two racing conditional batches write a missing key once', async ({ open }) => {
      const { store } = await open();
      const [first, second] = await Promise.all([
        store.setMany([{ key: 'race', value: 1, options: { ifAbsent: true } }]),
        store.setMany([{ key: 'race', value: 2, options: { ifAbsent: true } }]),
      ]);
      assert.deepEqual([first[0], second[0]].sort(), ['exists', 'written']);
    });
    rule('S7 deleteMany counts live entries, and a repeated key counts once', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      await store.setMany([{ key: 'a', value: 1 }, { key: 'b', value: 1 }]);
      await store.set('old', 1, { expiresAt: PAST() });
      for (const keys of [new Array(1), ['a', , 'b']]) {
        await noCall(subject, () => rejectsWith(store.deleteMany(keys), 'invalid_key'));
      }
      assert.deepEqual(await store.getMany(['a', 'b']), [HIT(1), HIT(1)], 'a sparse batch deletes nothing');
      assert.equal(await store.deleteMany(['a', 'a', 'old', 'absent', 'b']), 2);
      assert.equal(await noCall(subject, () => store.deleteMany([])), 0);
      assert.deepEqual(await store.getMany(['a', 'b']), [MISS, MISS]);
    });
    rule('S8 deletePrefix matches bytes literally, counts live entries and refuses the empty prefix', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      const keys = ['user:1', 'user:2', 'user', 'users', 'usex', '%_x', '%_\\y', 'a%b', 'é1', 'é', '퟿1', '￿1', '\u{10ffff}1', '\u{10ffff}'];
      await store.setMany(keys.map((key) => ({ key, value: 1 })));
      await store.set('user:old', 1, { expiresAt: PAST() });
      assert.equal(await store.deletePrefix('user:'), 2);
      assert.deepEqual(await store.getMany(['user', 'users', 'usex']), [HIT(1), HIT(1), HIT(1)]);
      assert.equal(await store.deletePrefix('%_'), 2);
      assert.deepEqual(await store.get('a%b'), HIT(1));
      assert.equal(await store.deletePrefix('é'), 2);
      assert.equal(await store.deletePrefix('퟿'), 1);
      assert.equal(await store.deletePrefix('￿'), 1);
      assert.equal(await store.deletePrefix('\u{10ffff}'), 2);
      assert.equal(await store.deletePrefix('nothing'), 0);
      await noCall(subject, () => rejectsWith(store.deletePrefix(''), 'invalid_key'));
    });
    rule('S9 ttl, expire and persist change and report only a live entry', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      await store.set('k', 1);
      assert.deepEqual(await store.ttl('k'), { state: 'persistent' });
      assert.equal(await store.expire('k', { ttlMs: HOUR }), true);
      const left = await store.ttl('k');
      assert.equal(left.state, 'expiring');
      assert.ok(Number.isSafeInteger(left.ms) && left.ms > 0 && left.ms <= HOUR);
      assert.equal(await store.persist('k'), true);
      assert.deepEqual(await store.ttl('k'), { state: 'persistent' });
      assert.equal(await store.expire('k', { expiresAt: PAST() }), true);
      assert.deepEqual(await store.get('k'), MISS);
      assert.equal(await store.expire('k', { ttlMs: HOUR }), false, 'an expired entry does not become live');
      assert.equal(await store.persist('k'), false);
      assert.equal(await store.expire('absent', { ttlMs: HOUR }), false);
      assert.deepEqual(await store.ttl('absent'), { state: 'missing' });
      await noCall(subject, () => rejectsWith(store.expire('k', {}), 'invalid_ttl'));
      await noCall(subject, () => rejectsWith(store.expire('k', { ttlMs: 0 }), 'invalid_ttl'));
    });
    rule('S10 cleanupExpired deletes expired entries in batches and never a live one', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      await store.setMany([1, 2, 3, 4, 5].map((index) => ({ key: `old${index}`, value: index, options: { expiresAt: PAST() } })));
      await store.setMany([{ key: 'live', value: 1 }, { key: 'later', value: 1, options: { ttlMs: HOUR } }]);
      assert.deepEqual(await store.cleanupExpired({ batchSize: 2, maxBatches: 1 }), { deleted: 2, batches: 1 });
      assert.deepEqual(await store.cleanupExpired({ batchSize: 2 }), { deleted: 3, batches: 2 });
      assert.deepEqual(await store.cleanupExpired(), { deleted: 0, batches: 1 });
      assert.deepEqual(await store.getMany(['live', 'later']), [HIT(1), HIT(1)]);
      for (const options of [{ batchSize: 0 }, { batchSize: 1.5 }, { maxBatches: 0 }, { maxBatches: -1 }, 'all']) {
        await noCall(subject, () => rejectsWith(store.cleanupExpired(options), 'invalid_batch'));
      }
    });
    rule('S10 namespaces with overlapping names stay apart for every operation', async ({ open, t }) => {
      const subject = await open({ namespace: 'a' });
      if (typeof subject.sibling !== 'function') {
        t.skip('the factory has no sibling(): namespace isolation is not checked');
        return;
      }
      const a = subject.store;
      const ab = (await subject.sibling({ namespace: 'ab' })).store;
      const root = (await subject.sibling({ namespace: '' })).store;
      await a.set('bc', 'from a');
      await ab.set('c', 'from ab');
      await root.set('abc', 'from root');
      assert.deepEqual([await a.get('bc'), await ab.get('c'), await root.get('abc')], [HIT('from a'), HIT('from ab'), HIT('from root')]);
      assert.deepEqual(await ab.get('bc'), MISS);
      await ab.set('old', 1, { expiresAt: PAST() });
      await a.set('old', 1, { expiresAt: PAST() });
      assert.deepEqual(await a.cleanupExpired(), { deleted: 1, batches: 1 });
      assert.equal(await a.deletePrefix('b'), 1);
      assert.deepEqual(await ab.get('c'), HIT('from ab'));
      assert.deepEqual(await root.get('abc'), HIT('from root'));
      assert.deepEqual(await ab.cleanupExpired(), { deleted: 1, batches: 1 });
    });
    rule('S11 after close each call rejects with closed, and a second close too', async ({ open, t }) => {
      const subject = await open();
      const { store } = subject;
      await store.set('k', 1);
      const accepted = store.get('k');
      await store.close();
      assert.deepEqual(await accepted, HIT(1), 'accepted work settles before close resolves');
      for (const call of [() => store.get('k'), () => store.getMany(['k']), () => store.set('k', 2), () => store.setMany([]),
        () => store.delete('k'), () => store.deleteMany([]), () => store.deletePrefix('k'), () => store.has('k'), () => store.ttl('k'),
        () => store.expire('k', { ttlMs: 1 }), () => store.persist('k'), () => store.cleanupExpired(), () => store.close()]) {
        await noCall(subject, () => rejectsWith(call(), 'closed'));
      }
      if (typeof subject.sibling === 'function') {
        const other = (await subject.sibling({})).store;
        assert.deepEqual(await other.get('k'), HIT(1), 'close leaves the backend of the caller open');
      } else {
        t.diagnostic('the factory has no sibling(): the backend after close is not checked');
      }
    });
    rule('S12 each failure is one KvError: invalid_value and codec keep their cause', async ({ open }) => {
      const { codec, state } = controlledCodec();
      const subject = await open({ codec });
      const { store } = subject;
      const encodeCause = new Error('synthetic encode failure');
      state.failEncode = encodeCause;
      const refused = await noCall(subject, () => rejectsWith(store.set('k', 1), 'invalid_value'));
      assert.equal(refused.cause, encodeCause);
      state.failEncode = undefined;
      await store.set('k', 1);
      const decodeCause = new Error('synthetic decode failure');
      state.failDecode = decodeCause;
      assert.equal((await rejectsWith(store.get('k'), 'codec')).cause, decodeCause);
      assert.equal((await rejectsWith(store.getMany(['k', 'x']), 'codec')).cause, decodeCause, 'a decode error rejects the whole read');
      state.failDecode = undefined;
      assert.deepEqual(await store.get('k'), HIT(1), 'a later call works');
    });
    rule('S13 hook arguments hold safe fields only', async ({ open }) => {
      const events = [];
      const notices = [];
      const marker = 'KVPG_CONFORMANCE_PRIVATE_901';
      const { store } = await open({ namespace: marker, hooks: {
        onOperation(event) { events.push(event); if (event.operation === 'has') throw new Error(marker); },
        onHookError(notice) { notices.push(notice); },
      } });
      await store.set(marker, marker);
      await store.get(marker);
      assert.equal(await store.has(marker), true, 'a throwing hook keeps the result');
      await rejectsWith(store.get(`${marker}\0`), 'invalid_key');
      const text = JSON.stringify([events, notices]);
      assert.ok(!text.includes(marker), 'a hook argument holds private data');
      assert.deepEqual(notices, [{ code: 'hook' }]);
      for (const event of events) {
        assert.deepEqual(Object.keys(event).filter((field) => !['operation', 'keys', 'hits', 'durationMs', 'errorCode'].includes(field)), []);
      }
      assert.equal(events.at(-1).errorCode, 'invalid_key');
      assert.equal(events.find((event) => event.operation === 'get').hits, 1);
    });
    rule('S14 limits accept a value or a batch at the limit and refuse one over it without a backend call', async ({ open }) => {
      const subject = await open({ limits: { maxValueBytes: 12, maxBatchSize: 3 } });
      const { store } = subject;
      assert.equal(await store.set('k', 'a'.repeat(10)), true, 'the json codec encodes "aaaaaaaaaa" in 12 bytes');
      await noCall(subject, () => rejectsWith(store.set('k', 'a'.repeat(11)), 'value_too_large'));
      await noCall(subject, () => rejectsWith(store.setMany([{ key: 'x', value: 'a'.repeat(11) }]), 'value_too_large'));
      assert.deepEqual(await store.getMany(['a', 'b', 'c']), [MISS, MISS, MISS]);
      await noCall(subject, () => rejectsWith(store.getMany(['a', 'b', 'c', 'd']), 'batch_too_large'));
      await noCall(subject, () => rejectsWith(store.setMany(['a', 'b', 'c', 'd'].map((key) => ({ key, value: 1 }))), 'batch_too_large'));
      await noCall(subject, () => rejectsWith(store.deleteMany(['a', 'b', 'c', 'd']), 'batch_too_large'));
      await noCall(subject, () => rejectsWith(store.cleanupExpired({ batchSize: 4 }), 'batch_too_large'));
      assert.deepEqual(await store.cleanupExpired({ batchSize: 3 }), { deleted: 0, batches: 1 });
      const wide = (await open()).store;
      assert.equal(await wide.set('k', 'a'.repeat(11)), true, 'another store with the default limits accepts the value');
    });
    rule('Values: the json codec keeps JSON equality and refuses values outside the JSON data model', async ({ open }) => {
      const subject = await open();
      const { store } = subject;
      const values = [null, true, false, 0, -1.5, 'text', '', [], {}, [1, [2, { a: null }]], { b: 1, a: { c: [true] } }];
      for (const [index, value] of values.entries()) {
        await store.set(`v${index}`, value);
        assert.deepEqual(await store.get(`v${index}`), HIT(value));
      }
      await store.set('negative-zero', -0);
      assert.ok(Object.is((await store.get('negative-zero')).value, 0), '-0 becomes 0');
      const cycle = {};
      cycle.self = cycle;
      for (const value of [undefined, () => 1, Symbol('s'), 10n, cycle, Number.NaN, Number.POSITIVE_INFINITY, [1, , 3],
        new Date(0), new Map(), { nested: undefined }, Object.create({ inherited: 1 })]) {
        await noCall(subject, () => rejectsWith(store.set('bad', value), 'invalid_value'));
      }
    });
  });
}
