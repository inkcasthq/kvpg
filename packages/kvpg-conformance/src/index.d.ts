import type { Codec, Hooks, KvError, KvErrorCode, KvStore, Limits } from '@inkcasthq/kvpg';

/** The store options that the suite asks a factory to apply. Each one is optional. */
export interface SubjectConfig {
  readonly namespace?: string;
  readonly limits?: Limits;
  readonly defaultTtlMs?: number;
  readonly codec?: Codec<unknown>;
  readonly hooks?: Hooks;
}

/** One store under test, on a new and empty backend, with the controls of the suite. */
export interface Subject {
  readonly store: KvStore<unknown>;
  /** Closes the store if it is open, and releases the backend of this subject. */
  dispose(): Promise<void>;
  /** The backend calls of this store so far, for the rules that forbid a call. */
  queryCount?(): number;
  /** Another store on the same backend, for namespace isolation and S11. The suite disposes it. */
  sibling?(config: SubjectConfig): Promise<Subject>;
}

export interface ConformanceOptions {
  /** A reason to register every rule as skipped, for example a backend that is not configured. */
  readonly pending?: string | false;
}

/** Registers the suite of contract v1 for one store, with one `node:test` test for each rule. */
export function conformance(name: string, makeSubject: (config: SubjectConfig) => Promise<Subject>, options?: ConformanceOptions): void;

/** Rejects unless `promise` rejects with one KvError of `code`. Returns the error. */
export function rejectsWith(promise: Promise<unknown>, code: KvErrorCode): Promise<KvError>;

/** A json codec over text, with a switch to fail encode or decode. Its domain also holds `undefined`. */
export function controlledCodec(column?: 'bytea' | 'text' | 'jsonb'): {
  readonly state: { failEncode: unknown; failDecode: unknown };
  readonly codec: Codec<unknown>;
};
