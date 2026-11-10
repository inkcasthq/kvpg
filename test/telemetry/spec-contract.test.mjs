import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const standard = readFileSync(new URL('../../docs/standard.md', import.meta.url), 'utf8');
const combined = readFileSync(new URL('../../docs/spec-1.0.md', import.meta.url), 'utf8');

test('V4 the combined close contract does not exempt a public helper from S11', () => {
  assert.match(standard, /After `close`, each call rejects with `closed`/);
  const close = combined.split('## R11.')[1].split('## R12.')[0];
  assert.doesNotMatch(close, /`schemaSql\(\)`[^\n]*remains available/,
    'S11 does not grant a public helper an exception after close');
  assert.match(close, /`schemaSql\(\)`[^\n]*`closed`/,
    'the combined specification must state the public helper refusal');
});

test('V5 acceptance for open #12 does not impose the recommended sentinel policy', () => {
  const row = combined.split('\n').find((line) => line.startsWith('| OPEN #12:'));
  assert.ok(row, 'the missing-result choice must remain open');
  const acceptance = row.split('|')[4];
  assert.doesNotMatch(acceptance, /^\s*Refuse stored `undefined`/,
    'tagged reads do not select the reserved-undefined policy');
  assert.match(acceptance, /selected|selection/,
    'acceptance must follow the owner selection');
});
