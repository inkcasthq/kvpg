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

// The owner decided #12 on 2026-11-10 03:20 UTC (tagged read result), so V5 now guards the decided rule.
test('V5 the decided #12 row and S1 state the tagged read result, and no choice stays open', () => {
  const row = combined.split('\n').find((line) => line.startsWith('| DECIDED #12:'));
  assert.ok(row, 'R02 must record the #12 decision');
  assert.match(row, /`\{ found: true, value \}` or `\{ found: false \}`/, 'the decided rule is the tagged read result');
  assert.equal(combined.split('\n').filter((line) => line.startsWith('| OPEN #')).length, 0, 'R02 holds no open choice');
  const s1 = standard.split('\n').find((line) => line.startsWith('S1.'));
  assert.match(s1, /`\{ found: false \}`/, 'S1 states the missing result');
  assert.match(s1, /`\{ found: true, value: undefined \}`/, 'S1 keeps a stored undefined distinct from a missing key');
});
