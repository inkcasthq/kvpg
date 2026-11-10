// The suite on the reference store with one planted defect: get returns expired entries.
// planted.test.mjs runs this file in a child process. It is not a test of `npm test` by itself.
import { conformance } from '@inkcasthq/kvpg-conformance';
import { memorySubjects } from './memory-store.mjs';

conformance('memory reference with the expired-read defect', memorySubjects('expired-read'));
