import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../src/request.js';

test('only human-provided control lines select the acceptance check and shared files', () => {
  const req = parseRequest(' Fix clamp(-1)\nPreserve positive values.\n@file src/clamp.js\n@check node --test');
  assert.deepEqual(req, {task: 'Fix clamp(-1)\nPreserve positive values.', files: ['src/clamp.js'], command: 'node --test'});
  for (const bad of ['no check', 'fix\n@file ../key\n@check ls', 'fix\n@check ls\n@check ls', '@check ls']) assert.throws(() => parseRequest(bad));
});
