import assert from 'node:assert/strict';
import { clamp } from './boundary.mjs';
assert.equal(clamp(-1, 9), 0, 'clamp(-1, 9) must be zero');
