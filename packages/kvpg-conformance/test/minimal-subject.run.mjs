// The suite on a factory without the optional controls `sibling()` and `queryCount()`.
// planted.test.mjs runs this file in a child process: the checks that need those controls must show as not run.
import { conformance } from '@inkcasthq/kvpg-conformance';
import { memorySubjects } from './memory-store.mjs';

const full = memorySubjects();
conformance('memory reference without optional controls', async (config) => {
  const { store, dispose } = await full(config);
  return { store, dispose };
});
