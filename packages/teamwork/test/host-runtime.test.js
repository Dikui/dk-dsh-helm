// Installed-runtime check for the /teamwork Host layer. The Cordis command,
// tools, storage and scripted child activations are real; the acceptance check
// is a real node fixture executed with constant argv (never a shell).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as plugin from '../index.js';

const runtime = process.env.DSH_TEST_RUNTIME;
const tick = () => new Promise(resolve => setImmediate(resolve));
const confirmLine = text => {
  const line = text.match(/^\s*(\/teamwork confirm \S+[^\n]*?)\s*$/mu)?.[1];
  assert.ok(line, text);
  return { line, runId: line.match(/confirm (\S+)/u)[1] };
};

test('installed DSH runtime: /teamwork skip → inert wrong confirm → confirmed team → honest receipts', { skip: !runtime && 'Set DSH_TEST_RUNTIME to the DSH package resolver manifest' }, async t => {
  const require = createRequire(runtime);
  const { Context } = require('@deepseek-ai/cordis');
  const ctx = new Context();
  const provide = (key, value) => { ctx.provide(key); ctx.set(key, value); };
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'dk-teamwork-work-')));
  const storeRoot = await mkdtemp(path.join(tmpdir(), 'dk-teamwork-store-'));
  const logs = [];
  const parent = { id: 'root-host-runtime', session: { append: (...args) => logs.push(args) } };
  const activations = [], bashCalls = [], prompts = new Map();
  let expected = null;
  provide('systemPrompt', { tools() {}, section() {} });
  provide('workingDirectory', { ensure: async () => workspace });
  provide('fs', {
    resolve: async (file, { cwd = workspace } = {}) => ({ targetKey: await realpath(path.resolve(cwd, file)) }),
    processPath: target => target.targetKey,
    contains: (root, target) => !path.relative(root.targetKey, target.targetKey).startsWith('..'),
  });
  provide('subagents', {
    rootOf: agent => agent,
    resolveMaxDepth: () => 2,
    async startActivation(spec) {
      assert.equal(spec.parent, parent);
      assert.equal(spec.provider, 'spawn');
      assert.equal(spec.delivery, 'caller');
      assert.equal(spec.cwd, workspace);
      const role = spec.agentPreset.replace(/^dk-teamwork-/u, '');
      const prompt = spec.prompt[0].text;
      activations.push(role);
      prompts.set(role, prompt);
      const text = role === 'implementer'
        ? 'Updated the clamp fixture in work.txt.\nVERDICT|pass|implementation complete'
        : role === 'auditor'
          ? 'Independent audit against this round’s recorded receipt.\nVERDICT|pass|audit ok\nPHASE A|pass\nPHASE B|pass\nPHASE C|pass'
          : 'Read work.txt and the recorded receipt.\nVERDICT|pass|no issues';
      return { childId: spec.childId, dispose: async () => {},
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }) };
    },
  });
  const fibers = [ctx.plugin(require('@deepseek-ai/dsh-commands').CommandRuntime), ctx.plugin(require('@deepseek-ai/dsh-tools').default)];
  const execute = async line => (await ctx.commands.execute(parent, `/teamwork ${line}`, [], new AbortController().signal)).result;
  const report = async runId => {
    const status = await execute(`status ${runId}`), dossier = await execute(`dossier ${runId}`);
    assert.equal(status.kind, 'success', status.text);
    assert.equal(dossier.kind, 'success', dossier.text);
    return { status: status.text, dossier: dossier.text };
  };
  try {
    await tick();
    fibers.push(ctx.plugin(require('@deepseek-ai/dsh-tool-executor-native'))); await tick();
    function addTool(name, outputSchema, run) {
      ctx.tools.register({ name, description: `Test ${name}`, parameters: { type: 'object', additionalProperties: true },
        output: { schema: outputSchema, render: (_args, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] }, execute: run });
    }
    // The only accepted check: exact command text and a constant fixture argv.
    addTool('bash', { type: 'object', additionalProperties: true }, async args => {
      assert.ok(expected, 'a check ran before any confirmation');
      assert.equal(args.command, expected.command);
      assert.equal(args.workdir, workspace);
      const proc = spawnSync(process.execPath, [expected.script], { cwd: workspace, encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      bashCalls.push({ command: args.command, script: expected.script, exitCode: proc.status });
      assert.equal(proc.status, expected.exitCode, proc.stderr);
      return { kind: 'foreground', exitCode: proc.status, stdout: { text: proc.stdout }, stderr: { text: proc.stderr } };
    });
    addTool('read', { type: 'string' }, async args => readFile(args.file_path, 'utf8'));
    fibers.push(ctx.plugin(require('@deepseek-ai/dsh-storage').default)); await tick();
    fibers.push(ctx.plugin(require('@deepseek-ai/dsh-storage-json'), { root: storeRoot })); await tick();
    fibers.push(ctx.plugin(require('@deepseek-ai/dsh-storage-domain'), { backend: 'json' })); await tick();
    fibers.push(ctx.plugin(plugin)); await tick();
    await writeFile(path.join(workspace, 'work.txt'), 'export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));\n');
    await writeFile(path.join(workspace, 'accept-pass.mjs'), "console.log('acceptance ok')\n");
    await writeFile(path.join(workspace, 'accept-fail.mjs'), "import assert from 'node:assert/strict'\nassert.equal(1, 2, 'fixture check must fail')\n");
    await writeFile(path.join(workspace, 'general-pass.mjs'), "console.log('general acceptance ok')\n");

    let runIdA = null, confirmedA = null;
    await t.test('a wrong confirmation starts no child and runs no check', async () => {
      expected = { command: 'node accept-pass.mjs', script: 'accept-pass.mjs', exitCode: 0 };
      const created = await execute('skip --mode swe-light Add a clamp helper and prove it.\n@file work.txt\n@check node accept-pass.mjs');
      assert.equal(created.kind, 'success', created.text);
      const draft = confirmLine(created.text);
      runIdA = draft.runId;
      assert.match(created.text, /No child has started\./);
      const wrong = await execute(`${draft.line.replace(/^\/teamwork\s+/u, '')} please`);
      assert.equal(wrong.kind, 'error');
      assert.match(wrong.text, /does not match/);
      assert.match(wrong.text, /No child started/);
      const idle = await report(runIdA);
      assert.match(idle.status, /status awaiting-confirm ·/);
      assert.deepEqual(activations, []);
      assert.deepEqual(bashCalls, []);
      confirmedA = await execute(draft.line.replace(/^\/teamwork\s+/u, ''));
      assert.equal(confirmedA.kind, 'success', confirmedA.text);
    });
    await t.test('the confirmed swe-light run implements, verifies, and passes a fresh audit', async () => {
      const view = await report(runIdA);
      assert.match(view.status, /status done ·/, view.status);
      assert.match(view.status, /audit passed/);
      assert.match(view.status, /tasks 2\/2 passed/);
      assert.match(prompts.get('reviewer'), /Math\.min\(hi/, 'the reviewer must receive the human-selected file contents, not just a filename');
      for (const role of ['implementer', 'reviewer', 'auditor']) {
        const prompt = prompts.get(role);
        assert.match(prompt, /FROZEN CAMPAIGN SPEC \(authoritative/u, `${role} receives the frozen spec`);
        assert.match(prompt, /Constraints: Follow the confirmed original request exactly/u);
        assert.match(prompt, /Integrity restrictions:/u);
        assert.match(prompt, /Standard library only: no/u);
      }
      assert.match(view.status, /open issues 0/);
      assert.match(view.status, /last acceptance: exit 0 — node accept-pass\.mjs/);
      assert.match(view.dossier, /Decision: pass; independent audit: passed/);
      assert.match(view.dossier, /Last receipt: exit 0/);
      assert.match(view.dossier, /impl-r1 · implementer: pass/);
      assert.match(view.dossier, /review-r1 · reviewer: pass/);
      assert.deepEqual(activations, ['implementer', 'reviewer', 'auditor']);
      // A verifier sees this round’s receipt, not just the task text.
      assert.match(prompts.get('reviewer'), /acceptance ok|exit 0/);
      assert.match(prompts.get('auditor'), /Acceptance result: exit 0/);
      // One check after this round’s writer, another immediately before the
      // independent audit: a stale receipt cannot sign off new code.
      assert.deepEqual(bashCalls.map(call => call.script), ['accept-pass.mjs', 'accept-pass.mjs']);
    });
    await t.test('general mode runs the confirmed command, not an old check', async () => {
      expected = { command: 'node general-pass.mjs', script: 'general-pass.mjs', exitCode: 0 };
      activations.length = 0; prompts.clear();
      const created = await execute('skip --mode general Add a clamp helper and prove it.\n@check node general-pass.mjs');
      const draft = confirmLine(created.text);
      const genRun = draft.runId;
      const confirmedGen = await execute(draft.line.replace(/^\/teamwork\s+/u, ''));
      assert.equal(confirmedGen.kind, 'success', confirmedGen.text);
      const view = await report(genRun);
      assert.match(view.status, /status done ·/, view.status);
      assert.match(view.status, /last acceptance: exit 0 — node general-pass\.mjs/);
      assert.deepEqual(bashCalls.slice(2).map(call => call.script), ['general-pass.mjs', 'general-pass.mjs'], JSON.stringify(bashCalls));
      assert.ok(activations.includes('implementer'));
      assert.match(prompts.get('implementer'), /explore-1.*Read work\.txt/s, 'writer receives the bounded durable exploration findings');
      assert.ok(activations.includes('reviewer'));
      assert.ok(activations.includes('auditor'));
      assert.match(view.dossier, /Decision: pass; independent audit: passed/);
    });
    await t.test('a failing acceptance cannot be signed off as done', async () => {
      expected = { command: 'node accept-fail.mjs', script: 'accept-fail.mjs', exitCode: 1 };
      activations.length = 0; prompts.clear();
      const created = await execute('skip --mode swe-light Fix the clamp helper.\n@check node accept-fail.mjs');
      const draft = confirmLine(created.text);
      const failRun = draft.runId;
      await execute(draft.line.replace(/^\/teamwork\s+/u, ''));
      const view = await report(failRun);
      assert.match(view.status, /status paused ·/, view.status);
      assert.doesNotMatch(view.status, /status done ·/);
      assert.match(view.status, /last acceptance: exit 1 — node accept-fail\.mjs/);
      assert.doesNotMatch(view.status, /audit passed/);
      assert.match(view.dossier, /Last receipt: exit 1/);
      assert.doesNotMatch(view.dossier, /independent audit: passed/);
      assert.equal(prompts.has('auditor'), false, 'do not consult an auditor to override a real failure');
      assert.deepEqual(bashCalls.slice(4).map(call => call.script), ['accept-fail.mjs']);
    });
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    for (const root of [workspace, storeRoot]) {
      assert.ok(path.basename(root).startsWith('dk-teamwork-'), 'unexpected temporary root');
      await rm(root, { recursive: true, force: true });
    }
  }
});
