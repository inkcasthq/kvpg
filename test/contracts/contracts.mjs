import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CONTRACTS = join(ROOT, 'contracts');
export const SAMPLES = join(CONTRACTS, 'samples');

const UTF8_RULES = Object.freeze(['maxBytes', 'wellFormed', 'noNul']);
// RFC 3339 date-time, the payload form of a Date (contracts/README.md).
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The rule of `x-kvpg-utf8` that `text` breaks, or undefined. Rules S3 and S8. */
export function utf8Violation(text, rules) {
  if (rules.wellFormed && !text.isWellFormed()) return 'wellFormed';
  if (rules.noNul && text.includes('\0')) return 'noNul';
  if (rules.maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > rules.maxBytes) return 'maxBytes';
  return undefined;
}

/** Each schema file of contracts/, as { file, schema }, with `file` relative to contracts/ and `/` separators. */
export function schemaFiles() {
  return readdirSync(CONTRACTS, { recursive: true })
    .filter((file) => file.endsWith('.schema.json'))
    .sort()
    .map((file) => ({ file: file.split(sep).join('/'), schema: JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8')) }));
}

/** Each samples file of contracts/samples/, as { file, samples }. */
export function sampleFiles() {
  return readdirSync(SAMPLES, { recursive: true })
    .filter((file) => file.endsWith('.samples.json'))
    .sort()
    .map((file) => ({ file: relative(SAMPLES, join(SAMPLES, file)).split(sep).join('/'),
      samples: JSON.parse(readFileSync(join(SAMPLES, file), 'utf8')) }));
}

/** A strict Ajv 2020-12 instance with every contract schema and the two kvpg extensions. */
export function createAjv(files = schemaFiles()) {
  // strictRequired is off: a conditional part (then, else) names properties that its enclosing object schema defines.
  // strictTuples is off: an optional trailing argument makes minItems lower than the tuple length, and items: false
  // still closes the tuple. Every other strict rule is on.
  const ajv = new Ajv2020({ strict: true, strictRequired: false, strictTuples: false, allErrors: true });
  ajv.addFormat('date-time', { type: 'string', validate: (text) => DATE_TIME.test(text) && !Number.isNaN(Date.parse(text)) });
  ajv.addKeyword({
    keyword: 'x-kvpg-utf8',
    type: 'string',
    schemaType: 'object',
    metaSchema: {
      type: 'object',
      properties: { maxBytes: { type: 'integer', minimum: 1 }, wellFormed: { const: true }, noNul: { const: true } },
      additionalProperties: false,
    },
    errors: true,
    validate: function validateUtf8(rules, text) {
      const rule = utf8Violation(text, rules);
      validateUtf8.errors = rule === undefined ? null
        : [{ keyword: 'x-kvpg-utf8', message: `must satisfy ${rule}`, params: { rule } }];
      return rule === undefined;
    },
  });
  for (const { schema } of files) ajv.addSchema(schema);
  return ajv;
}

export { UTF8_RULES };
