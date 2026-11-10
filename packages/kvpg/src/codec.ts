/**
 * The default codec `json` (RF18): the JSON data model in a `bytea` column.
 */
import type { Codec } from './extension.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The reason why `value` is outside the JSON data model, or undefined.
 * The data model holds null, booleans, strings, finite numbers, dense arrays and plain objects with string keys.
 * The reason names a type, never a part of the value (S13).
 */
export function jsonDomainProblem(value: unknown, path: Set<object> = new Set()): string | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'a number that is not finite';
  if (typeof value !== 'object') return `a value of type ${typeof value}`;
  if (path.has(value)) return 'a cycle';
  path.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) return 'a sparse array';
        const problem = jsonDomainProblem(value[index], path);
        if (problem) return problem;
      }
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return 'an object that is not a plain object';
    if (Object.getOwnPropertySymbols(value).length > 0) return 'an object with a symbol key';
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor)) return 'an object with an accessor property';
      if (!descriptor.enumerable) return 'an object with a non-enumerable property';
      const problem = jsonDomainProblem(descriptor.value, path);
      if (problem) return problem;
    }
    return undefined;
  } finally {
    path.delete(value);
  }
}

/** The default codec. Encode refuses a value outside the JSON data model, so the round trip keeps JSON equality. */
export const jsonCodec: Codec<unknown> = Object.freeze({
  name: 'json',
  column: 'bytea',
  encode(value: unknown): Uint8Array {
    const problem = jsonDomainProblem(value);
    if (problem) throw new TypeError(`kvpg json codec: the value holds ${problem}`);
    return encoder.encode(JSON.stringify(value));
  },
  decode(stored: Uint8Array | string): unknown {
    return JSON.parse(typeof stored === 'string' ? stored : decoder.decode(stored));
  },
});
