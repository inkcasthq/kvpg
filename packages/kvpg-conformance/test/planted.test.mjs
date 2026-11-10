// R15: a planted expired-read defect fails S1, and the corrected reference passes (reference.test.mjs).
// The planted run is a child process, so its failures are evidence here and not failures of this run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const PLANTED = fileURLToPath(new URL('./planted-expired-read.run.mjs', import.meta.url));
const MINIMAL = fileURLToPath(new URL('./minimal-subject.run.mjs', import.meta.url));

/** Runs one suite file in a child process and returns its TAP report. */
function runChild(file) {
  // Under `node --test`, NODE_TEST_CONTEXT makes a child report to its parent runner. This child reports in TAP instead.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test-reporter=tap', file], { encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(run.error, undefined);
  return run;
}

/** The leaf results of a TAP report: `{ name, ok }` for each test whose name starts with a rule. */
function ruleResults(tap) {
  return [...tap.matchAll(/^\s+(ok|not ok) \d+ - ((?:S\d+|Values)\b[^#\n]*?)\s*(?:#.*)?$/gm)]
    .map(([, status, name]) => ({ name, ok: status === 'ok' }));
}

test('R15 the planted expired-read defect fails S1, and only the rules whose get reads an expired entry', () => {
  const run = runChild(PLANTED);
  assert.notEqual(run.status, 0, 'the planted run must fail');
  const results = ruleResults(run.stdout);
  assert.ok(results.length >= 20, `expected the whole suite in the report, found ${results.length} rule results`);
  const failed = results.filter((result) => !result.ok).map((result) => result.name.split(' ')[0]);
  // Each of these rules reads an entry with get after its expiry: S1 (an expired key), S4 (a past date and a short
  // ttlMs) and S9 (expire to a past date). No other rule reads an expired entry with get.
  assert.deepEqual(failed, ['S1', 'S4', 'S9']);
  const s1 = results.find((result) => result.name.startsWith('S1 a read never returns an expired entry'));
  assert.equal(s1?.ok, false, 'S1 names the defect');
});

test('a factory without sibling() and queryCount() gets a skip and notes, not a silent pass', () => {
  const run = runChild(MINIMAL);
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /^\s+ok \d+ - S10 namespaces with overlapping names stay apart for every operation # SKIP the factory has no sibling\(\)/m);
  assert.match(run.stdout, /# queryCount\(\) is missing: the no-call checks of this rule did not run/);
  assert.match(run.stdout, /# the factory has no sibling\(\): the backend after close is not checked/);
});
