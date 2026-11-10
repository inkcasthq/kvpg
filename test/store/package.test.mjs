// The package metadata that the store reports: VERSION is the version of the package manifest (T04 scope version).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { VERSION } from '@inkcasthq/kvpg';

test('VERSION equals the version of packages/kvpg/package.json', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../packages/kvpg/package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, manifest.version);
});
