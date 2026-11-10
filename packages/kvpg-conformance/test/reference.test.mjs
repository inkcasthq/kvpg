// The suite on its reference store in memory. Every rule must pass (docs/spec-1.0.md R15).
import { conformance } from '@inkcasthq/kvpg-conformance';
import { memorySubjects } from './memory-store.mjs';

conformance('memory reference', memorySubjects());
