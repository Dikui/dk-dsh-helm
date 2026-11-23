import test from 'node:test';
import assert from 'node:assert/strict';
import { runChild } from '../src/child.js';

test('aborting a published child awaits exact activation disposal and rejects partial output', async () => {
  const ctrl = new AbortController(); let disposed = 0, finish;
  const ctx = { subagents: { resolveMaxDepth: () => 1, startActivation: async spec => {
    assert.equal(spec.agentPreset, 'dk-boost-worker'); assert.equal(spec.delivery, 'caller');
    const result = new Promise(resolve => { finish = resolve; });
    setImmediate(() => ctrl.abort(new Error('cancelled by user')));
    return { result, dispose: async () => { disposed++; finish({stopReason:'aborted', output:[]}); } };
  } } };
  await assert.rejects(runChild(ctx, {role:'worker', parent:{}, cwd:'/repo', prompt:'do it', signal:ctrl.signal}), /cancelled by user/);
  assert.equal(disposed, 1);
});
