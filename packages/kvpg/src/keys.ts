/**
 * Keys, namespaces and key ranges (S3, S8, R05, R09, RF7 to RF9).
 */
import { KvError } from './contract.js';

/** The largest key of S3, in UTF-8 bytes. */
export const MAX_KEY_BYTES = 1024;

const encoder = new TextEncoder();
// In a `u` regular expression, a valid surrogate pair is one code point. Only a lone surrogate is in category Cs.
const LONE_SURROGATE = /\p{Cs}/u;

/** The UTF-8 length of a well-formed string. */
export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

/** True for a string of 1 to 1,024 UTF-8 bytes without NUL and without a lone surrogate (S3, RF7). */
export function isValidKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && !LONE_SURROGATE.test(key) && !key.includes('\0')
    && (key.length * 3 <= MAX_KEY_BYTES || utf8Length(key) <= MAX_KEY_BYTES);
}

/** The key itself, or a rejection with `invalid_key`. The message never holds the key (S13). */
export function checkKey(key: unknown): string {
  if (!isValidKey(key)) throw new KvError('invalid_key', 'kvpg: the key is not a string of 1 to 1,024 UTF-8 bytes without NUL or a lone surrogate');
  return key;
}

/** True for a namespace: the key rules, but it can be empty (R05). */
export function isValidNamespace(namespace: unknown): namespace is string {
  return namespace === '' || isValidKey(namespace);
}

/**
 * The frame of a namespace: its UTF-8 length, a colon and the namespace (RF8).
 * The length makes the frame of `a` differ from a prefix of the frame of `ab`.
 */
export function frame(namespace: string): string {
  return `${utf8Length(namespace)}:${namespace}`;
}

const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_FIRST = 0xd800;
const SURROGATE_LAST = 0xdfff;

/**
 * The smallest string that is greater than every string that starts with `prefix`, in code point order (RF9).
 * The last code point that is not U+10FFFF goes to its successor, and the code points after it are removed.
 * The successor skips the surrogate range. With COLLATE "C", PostgreSQL compares UTF-8 bytes, which keep this order.
 * It returns undefined when every code point is U+10FFFF: no upper bound exists, so the range has none.
 */
export function prefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix, (character) => character.codePointAt(0) as number);
  while (points.length > 0) {
    const last = points.pop() as number;
    if (last === MAX_CODE_POINT) continue;
    const next = last + 1 === SURROGATE_FIRST ? SURROGATE_LAST + 1 : last + 1;
    return String.fromCodePoint(...points, next);
  }
  return undefined;
}
