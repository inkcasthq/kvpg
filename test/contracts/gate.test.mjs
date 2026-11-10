// The contract gate: every valid sample passes its schema, and every invalid sample fails for its own stated reason.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAjv, sampleFiles, schemaFiles } from './contracts.mjs';

const files = schemaFiles();
const samples = sampleFiles();
const ajv = createAjv(files);
const byFile = new Map(files.map(({ file, schema }) => [file, schema]));
// Combinators that report one error for each failed branch. Without them, a refusal has exactly one leaf error.
const BRANCHING = new Set(['oneOf', 'anyOf', 'not']);
// A definition with no constraint has no invalid sample: any JSON value is a codec value (RF18).
const NO_INVALID_SAMPLE = new Set(['common.schema.json#value']);

/** The validator of one sample: the root of a schema with a type, else the named entry of its $defs. */
function validatorOf(schemaFile, def) {
  const schema = byFile.get(schemaFile);
  assert.ok(schema, `unknown schema file ${schemaFile}`);
  const id = def === undefined ? schema.$id : `${schema.$id}#/$defs/${def}`;
  const validate = ajv.getSchema(id);
  assert.ok(validate, `unknown definition ${schemaFile}#${def}`);
  return validate;
}

/** The targets that need samples: each $defs entry of a definitions file, or the root of a record schema. */
function targetsOf(file, schema) {
  return schema.type === undefined ? Object.keys(schema.$defs).map((def) => `${file}#${def}`) : [`${file}#`];
}

/** The errors that state a reason. Ajv adds an `if` error over each failed `then` or `else`, which repeats the leaf. */
function leafErrors(errors) {
  return errors.filter((error) => error.keyword !== 'if');
}

test('the contract schemas use no branching combinator, so each refusal has one leaf error', () => {
  const found = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}/${index}`));
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (BRANCHING.has(key)) found.push(`${path}/${key}`);
      if (key !== 'const' && key !== 'enum') walk(value, `${path}/${key}`);
    }
  };
  for (const { file, schema } of files) walk(schema, file);
  assert.deepEqual(found, []);
});

test('each schema file has one samples file, and each target has a valid and an invalid sample', () => {
  assert.deepEqual(samples.map(({ samples: s }) => s.schema).sort(), files.map(({ file }) => file).sort());
  const seen = new Map();
  for (const { samples: s } of samples) {
    for (const item of s.cases) {
      const target = `${s.schema}#${item.def ?? ''}`;
      const entry = seen.get(target) ?? { valid: 0, invalid: 0 };
      entry[item.valid ? 'valid' : 'invalid'] += 1;
      seen.set(target, entry);
    }
  }
  for (const { file, schema } of files) {
    for (const target of targetsOf(file, schema)) {
      const entry = seen.get(target) ?? { valid: 0, invalid: 0 };
      assert.ok(entry.valid > 0, `${target} has no valid sample`);
      if (!NO_INVALID_SAMPLE.has(target)) assert.ok(entry.invalid > 0, `${target} has no invalid sample`);
      seen.delete(target);
    }
  }
  assert.deepEqual([...seen.keys()], [], 'samples name a target that no schema defines');
});

/** Throws unless the sample passes (valid) or fails with exactly its stated keyword, path and params (invalid). */
function checkCase(validate, item) {
  const valid = validate(item.data);
  if (item.valid) {
    assert.equal(valid, true, `a valid sample was refused: ${JSON.stringify(validate.errors)}`);
    return;
  }
  assert.equal(valid, false, 'an invalid sample was accepted');
  const leaves = leafErrors(validate.errors);
  assert.equal(leaves.length, 1, `an invalid sample must break one rule, got ${JSON.stringify(leaves)}`);
  const [error] = leaves;
  assert.deepEqual({ keyword: error.keyword, instancePath: error.instancePath },
    { keyword: item.keyword, instancePath: item.instancePath }, 'the sample failed for another reason');
  for (const [name, value] of Object.entries(item.params ?? {})) {
    assert.deepEqual(error.params[name], value, `the reason differs in params.${name}`);
  }
}

test('the gate refuses a sample that states another reason or breaks two rules', () => {
  const validate = validatorOf('common.schema.json', 'setOptions');
  const zero = { valid: false, data: { ttlMs: 0 }, keyword: 'minimum', instancePath: '/ttlMs' };
  checkCase(validate, zero);
  assert.throws(() => checkCase(validate, { ...zero, keyword: 'type' }), /failed for another reason/);
  assert.throws(() => checkCase(validate, { ...zero, instancePath: '' }), /failed for another reason/);
  assert.throws(() => checkCase(validate, { ...zero, data: { ttlMs: 0, ifAbsent: 'yes' } }), /must break one rule/);
  assert.throws(() => checkCase(validate, { ...zero, data: { ttlMs: 1 } }), /was accepted/);
  const key = validatorOf('common.schema.json', 'key');
  const nul = { valid: false, data: 'a\0', keyword: 'x-kvpg-utf8', instancePath: '', params: { rule: 'noNul' } };
  checkCase(key, nul);
  assert.throws(() => checkCase(key, { ...nul, params: { rule: 'maxBytes' } }), /differs in params.rule/);
});

for (const { file, samples: s } of samples) {
  test(`samples of ${s.schema}`, async (t) => {
    const names = new Set();
    for (const item of s.cases) {
      const label = `${item.def ?? 'root'}: ${item.name}`;
      assert.ok(!names.has(label), `${file} repeats the case "${label}"`);
      names.add(label);
      await t.test(label, () => checkCase(validatorOf(s.schema, item.def), item));
    }
  });
}
