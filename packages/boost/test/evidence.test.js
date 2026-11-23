import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidence } from '../src/evidence.js';

// Stub only the DSH adapters; assert the evidence seen by the reviewer, not its prose.
const agent = { id: 'parent' }, signal = new AbortController().signal;
function host(overrides = {}) {
  return {
    fs: { resolve: async p => ({ displayPath: p }), contains: () => true, processPath: t => t.displayPath },
    tools: { execute: async ({ calls, agent: owner }) => {
      assert.equal(owner, agent);
      if (calls[0].name === 'read') return { results: [{ callId: calls[0].id, result: { isError: false, content: [{ type: 'text', text: 'export const clamp = n => n < 0 ? n : 0;' }] } }] };
      assert.equal(calls[0].name, 'bash');
      assert.equal(JSON.parse(calls[0].arguments).command, 'node --test');
      return { results: [{ callId: calls[0].id, result: { isError: false, value: {
        kind: 'foreground', exitCode: 1, stdout: { text: 'clamp(-1): expected 0, got -1' }, stderr: { text: '' },
      } } }] };
    } }, ...overrides,
  };
}
const spec = { cwd: '/project', files: ['clamp.js'], command: 'node --test' };
test('an actual failed check stays negative regardless of worker claims', async () => {
  const evidence = await collectEvidence(host(), agent, spec, signal);
  assert.equal(evidence.check.exitCode, 1);
  assert.match(evidence.check.stdout, /expected 0, got -1/);
  assert.match(evidence.files[0].text, /export const clamp/);
});

test('a source resolving outside the workspace is not passed to the read tool', async () => {
  const ctx = host(); ctx.fs.contains = () => false;
  const names = []; const execute = ctx.tools.execute;
  ctx.tools.execute = args => { names.push(args.calls[0].name); return execute(args); };
  await assert.rejects(collectEvidence(ctx, agent, spec, signal), /outside workspace/);
  assert.deepEqual(names, ['bash']);
});

test('a promoted check requests stop on the same job and cannot produce a verdict', async () => {
  const calls = [];
  const ctx = host({tools: {async execute({calls: [call]}) {
    calls.push([call.name, JSON.parse(call.arguments)]);
    return {results: [{callId: call.id, result: {value: {kind: 'promoted', jobId: 'check-42'}}}]};
  }}});
  await assert.rejects(collectEvidence(ctx, agent, spec, signal), /stop requested for job check-42/);
  assert.deepEqual(calls.map(([name]) => name), ['bash','job_kill']);
  assert.equal(calls[1][1].job_id,'check-42');
});

test('an interrupted check cannot become evidence even with exit zero', async () => {
  const ctx = host({tools: {async execute({calls: [call]}) {
    return {results: [{callId: call.id, result: {value: {kind: 'foreground', exitCode: 0, stopped: 'manual'}}}]};
  }}});
  await assert.rejects(collectEvidence(ctx, agent, spec, signal), /usable exit status/);
});
