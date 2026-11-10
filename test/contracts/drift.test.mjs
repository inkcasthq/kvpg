// The drift test: the JSON Schemas of contracts/ and the TypeScript types of packages/kvpg describe the same payloads,
// and the telemetry schemas match the tables of docs/telemetry.md. `npm test` builds the package first (pretest).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, KV_ERROR_CODES, OPERATIONS } from '../../packages/kvpg/dist/index.js';
import { ROOT, schemaFiles } from './contracts.mjs';

const files = schemaFiles();
const NONE = 'common.schema.json#/$defs/none';

function resolve(schemas, ref, file) {
  const [path, pointer = ''] = ref.split('#');
  const target = path === '' ? file : posix.normalize(posix.join(posix.dirname(file), path));
  const schema = schemas.find((item) => item.file === target)?.schema;
  assert.ok(schema, `unresolved $ref ${ref} in ${file}`);
  const node = pointer.split('/').slice(1).reduce((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
  assert.ok(node !== undefined, `unresolved $ref ${ref} in ${file}`);
  return { file: target, node, id: `${target}#${pointer}` };
}

/** The discriminated branches of an object schema: if/then/else parts that test one property against a const. */
function conditionals(node) {
  const parts = [...(node.allOf ?? []), ...(node.if ? [node] : [])];
  return parts.filter((part) => {
    const keys = Object.keys(part.if?.properties ?? {});
    return keys.length === 1 && 'const' in part.if.properties[keys[0]] && (part.if.required ?? []).includes(keys[0]);
  });
}

function objectToTs(toTs, node, file, input) {
  const properties = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const members = (props, needed) => `{ ${Object.entries(props)
    .map(([name, schema]) => `readonly ${JSON.stringify(name)}${needed.has(name) ? '' : '?'}: ${toTs(schema, file, input)}`)
    .join('; ')} }`;
  const parts = conditionals(node);
  if (parts.length === 0) return members(properties, required);
  const [tag] = new Set(parts.map((part) => Object.keys(part.if.properties)[0]));
  assert.ok(parts.every((part) => Object.keys(part.if.properties)[0] === tag), 'one discriminator per object');
  const domain = properties[tag]?.enum ?? (properties[tag]?.type === 'boolean' ? [true, false] : undefined);
  assert.ok(domain, `the discriminator ${tag} needs an enum or a boolean type`);
  return domain.map((value) => {
    const props = { ...properties, [tag]: { const: value } };
    const needed = new Set(required);
    for (const part of parts) {
      const applied = part.if.properties[tag].const === value ? part.then : part.else;
      for (const name of applied?.required ?? []) needed.add(name);
      for (const [name, schema] of Object.entries(applied?.properties ?? {})) {
        if (schema === false) { delete props[name]; needed.delete(name); }
      }
    }
    return members(props, needed);
  }).join(' | ');
}

/**
 * A converter from a schema to its TypeScript type, which resolves each $ref inside `schemas`.
 * Rules (contracts/README.md): a date-time string is Date, the `none` definition is void, an optional trailing
 * argument is `(T | undefined)?`, and an array of an operation input is readonly. Rules without a TypeScript form
 * (bounds, lengths, x-kvpg-utf8, dependentSchemas, other if/then/else parts) are runtime rules and are skipped.
 */
export function converter(schemas) {
  function toTs(node, file, input = false) {
    if (node === true || Object.keys(node).every((key) => ['description', '$comment', 'default', 'title'].includes(key))) return 'unknown';
    if (node.$ref) {
      const target = resolve(schemas, node.$ref, file);
      return target.id === NONE ? 'void' : toTs(target.node, target.file, input);
    }
    if ('const' in node) return JSON.stringify(node.const);
    if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(' | ');
    switch (node.type) {
      case 'string': return node.format === 'date-time' ? 'Date' : 'string';
      case 'integer':
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'object': return objectToTs(toTs, node, file, input);
      case 'array': {
        if (node.prefixItems) {
          assert.equal(node.items, false, 'a tuple must close with items: false');
          const needed = node.minItems ?? 0;
          return `[${node.prefixItems.map((item, index) => {
            const type = toTs(item, file, input);
            return index < needed ? type : `(${type} | undefined)?`;
          }).join(', ')}]`;
        }
        if (node.maxItems === 0) return '[]';
        return `${input ? 'readonly ' : ''}(${toTs(node.items, file, input)})[]`;
      }
      default: throw new Error(`unsupported schema form in ${file}: ${JSON.stringify(node).slice(0, 120)}`);
    }
  }
  return toTs;
}

const COMMON_PAIRS = Object.freeze({
  key: 'string', value: 'unknown', none: 'void', expiresAt: 'Date', positiveSafeInteger: 'number', nonnegativeSafeInteger: 'number',
  expiryOptions: 'ExpiryOptions', expireOptions: 'ExpiryOptions', setOptions: 'SetOptions', entry: 'Entry<unknown>',
  readResult: 'ReadResult<unknown>', writeOutcome: 'WriteOutcome', timeToLive: 'TimeToLive', cleanupOptions: 'CleanupOptions',
  cleanupResult: 'CleanupResult', limits: 'Limits', errorCode: 'KvErrorCode', operation: 'Operation',
});
const HOOK_PAIRS = Object.freeze({ operationEvent: 'OperationEvent', hookErrorNotice: 'HookErrorNotice' });

/** A TypeScript module with one `Equals` assertion for each pair of schema type and package type. */
export function driftSource(schemas, directory) {
  const find = (file) => schemas.find((item) => item.file === file).schema;
  const toTs = converter(schemas);
  const source = relative(directory, join(ROOT, 'packages', 'kvpg', 'src', 'index.js')).split(sep).join('/');
  const lines = [
    `import type { CleanupOptions, CleanupResult, Entry, ExpiryOptions, HookErrorNotice, KvErrorCode, Limits, Operation, OperationEvent, PostgresStore, ReadResult, SetOptions, TimeToLive, WriteOutcome } from '${source}';`,
    'type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
    'type Assert<T extends true> = T;',
    'type Store = PostgresStore<unknown>;',
  ];
  const labels = new Map();
  const assertEqual = (label, left, right) => {
    lines.push(`export type A${labels.size} = Assert<Equals<${left}, ${right}>>;`);
    labels.set(lines.length, label);
  };
  const common = find('common.schema.json');
  // Each definition is read through a $ref, as an operation schema reads it, so `none` gives void.
  for (const [name, type] of Object.entries(COMMON_PAIRS)) assertEqual(`common#${name}`, toTs({ $ref: `#/$defs/${name}` }, 'common.schema.json'), type);
  const hooks = find('telemetry/hooks.schema.json');
  for (const [name, type] of Object.entries(HOOK_PAIRS)) assertEqual(`hooks#${name}`, toTs({ $ref: `#/$defs/${name}` }, 'telemetry/hooks.schema.json'), type);
  const codes = [];
  for (const operation of OPERATIONS) {
    const file = `operations/${operation}.schema.json`;
    const { $defs } = find(file);
    assertEqual(`${operation}#input`, toTs($defs.input, file, true), `Parameters<Store['${operation}']>`);
    assertEqual(`${operation}#result`, toTs($defs.result, file), `Awaited<ReturnType<Store['${operation}']>>`);
    const code = toTs($defs.error.properties.code, file);
    assertEqual(`${operation}#error`, `Exclude<${code}, KvErrorCode>`, 'never');
    codes.push(`(${code})`);
  }
  assertEqual('all operation error codes', codes.join(' | '), 'KvErrorCode');
  return { text: `${lines.join('\n')}\n`, labels };
}

/** Runs tsc on the drift module. Returns the labels of the failed assertions, or [] when every pair is equal. */
function compile(schemas) {
  const cache = join(ROOT, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, 'kvpg-drift-'));
  try {
    const { text, labels } = driftSource(schemas, directory);
    writeFileSync(join(directory, 'drift.ts'), text);
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      extends: join(ROOT, 'tsconfig.base.json'),
      compilerOptions: { noEmit: true, types: [], declaration: false, sourceMap: false },
      files: ['drift.ts'],
    }));
    try {
      execFileSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', join(directory, 'tsconfig.json')], { encoding: 'utf8', stdio: 'pipe' });
      return [];
    } catch (error) {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      const failed = [...output.matchAll(/drift\.ts\((\d+),\d+\): error/g)].map((match) => labels.get(Number(match[1])) ?? `line ${match[1]}`);
      assert.ok(failed.length > 0, `tsc failed outside the drift assertions:\n${output}`);
      return [...new Set(failed)];
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('each schema type equals its TypeScript type', () => {
  assert.deepEqual(compile(files), []);
});

test('the drift test fails when a schema and a type differ', () => {
  const mutated = structuredClone(files);
  mutated.find((item) => item.file === 'common.schema.json').schema.$defs.writeOutcome.enum = ['written'];
  assert.deepEqual(compile(mutated).sort(), ['common#writeOutcome', 'setMany#result']);
});

test('the operation files, codes, operations and limit defaults equal the package constants', () => {
  const operations = files.filter(({ file }) => file.startsWith('operations/')).map(({ file }) => file.slice(11, -12));
  assert.deepEqual(operations.sort(), [...OPERATIONS].sort());
  const common = files.find(({ file }) => file === 'common.schema.json').schema.$defs;
  assert.deepEqual(common.errorCode.enum, [...KV_ERROR_CODES]);
  assert.deepEqual(common.operation.enum, [...OPERATIONS]);
  assert.deepEqual({ maxValueBytes: common.limits.properties.maxValueBytes.default, maxBatchSize: common.limits.properties.maxBatchSize.default },
    { ...DEFAULT_LIMITS });
});

const telemetry = readFileSync(join(ROOT, 'docs', 'telemetry.md'), 'utf8');
/** The body rows of the first table under a `## <id>.` heading of docs/telemetry.md, with backticks removed. */
function tableRows(id) {
  const section = telemetry.split(/^## /m).find((part) => part.startsWith(`${id}.`));
  assert.ok(section, `docs/telemetry.md has no section ${id}`);
  const rows = section.split('\n').filter((line) => line.startsWith('|'));
  return rows.slice(2).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', '')));
}
const schemaOf = (file) => files.find((item) => item.file === file).schema;
/** The `then` part of each `if` that tests `property` against a const, keyed by that const. */
function branches(schema, property) {
  return Object.fromEntries(schema.allOf.filter((part) => part.if?.properties?.[property]).map((part) => [part.if.properties[property].const, part.then]));
}

test('the span schema matches T04 and the T07 allowlist', () => {
  const spans = schemaOf('telemetry/spans.schema.json');
  const rows = tableRows('T04');
  assert.deepEqual(rows.map(([method]) => method), [...OPERATIONS]);
  assert.deepEqual(spans.properties.name.enum, rows.map(([, name]) => name));
  assert.ok(rows.every(([, , kind]) => kind === spans.properties.kind.const));
  const allowed = new Set(tableRows('T07').map(([field]) => field));
  for (const name of Object.keys(spans.properties.attributes.properties)) assert.ok(allowed.has(name), `${name} is not in T07`);
  assert.equal(spans.properties.attributes.properties['error.type'].$ref, '../common.schema.json#/$defs/errorCode');
});

test('the metric schema matches T09', () => {
  const metrics = schemaOf('telemetry/metrics.schema.json');
  const rows = tableRows('T09');
  const then = branches(metrics, 'name');
  assert.deepEqual(metrics.properties.name.enum, rows.map(([name]) => name));
  for (const [name, instrument, unit] of rows) {
    assert.deepEqual([then[name].properties.instrument.const, then[name].properties.unit.const], [instrument.toLowerCase(), unit], name);
  }
  const allowed = new Set(tableRows('T07').map(([field]) => field));
  for (const name of Object.keys(metrics.properties.attributes.properties)) assert.ok(allowed.has(name), `${name} is not in T07`);
});

test('the log schema matches T10 and the hook schema matches T07', () => {
  const logs = schemaOf('telemetry/logs.schema.json');
  const rows = tableRows('T10');
  const then = branches(logs, 'eventName');
  assert.deepEqual(logs.properties.eventName.enum, rows.map(([name]) => name));
  for (const [name, severity, body] of rows) {
    assert.deepEqual([then[name].properties.severityNumber.const, then[name].properties.body.const], [Number(severity), body], name);
  }
  assert.deepEqual(logs.properties.attributes.properties['error.type'].enum, [...KV_ERROR_CODES, 'hook']);
  const allowed = new Set(tableRows('T07').map(([field]) => field));
  for (const name of Object.keys(logs.properties.attributes.properties)) assert.ok(allowed.has(name), `${name} is not in T07`);
  const hooks = schemaOf('telemetry/hooks.schema.json').$defs;
  const hookFields = tableRows('T07').filter(([field]) => field.startsWith('Hook ')).flatMap(([field]) => field.slice(5).split(', '));
  assert.deepEqual(Object.keys(hooks.operationEvent.properties).sort(), hookFields.sort());
});
