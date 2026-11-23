import { runBoost } from './src/protocol.js';
import { armReveal } from './src/reveal.js';
import { parseRequest, usage } from './src/request.js';
import { runChild } from './src/child.js';
import { collectEvidence } from './src/evidence.js';

export const name = 'dk-boost-command';
export const inject = ['commands', 'subagents', 'workingDirectory', 'fs', 'tools'];

function summarizeCheck({ command, exitCode, stdout, stderr, truncated }) {
  return [`Acceptance command ${exitCode === 0 ? 'passed (review separately below)' : 'FAILED'} (exit ${exitCode}): ${command}`,
    ...(exitCode !== 0 ? [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`, truncated && '[check output truncated]'].filter(Boolean) : [])].join('\n');
}

export function apply(ctx) {
  const lifecycle = new AbortController(), busy = new Set(), pending = new Set();
  ctx.effect(() => async () => {
    lifecycle.abort(new Error('Boost unloaded'));
    await Promise.allSettled([...pending]);
  });
  ctx.commands.register({ definitionId: '@local/dk-dsh-boost', name: 'boost',
    description: 'Implement a task, then get an independent review against code and a real acceptance check.',
    input: { hint: '<task> ↵ @file <source> ↵ @check <command>' },
    handler(invocation) {
      const op = execute(invocation);
      pending.add(op);
      return op.finally(() => pending.delete(op));
    } });

  async function execute({ agent, rawInput, signal: requestSignal }) {
    if (['', '--help', '-h', 'help'].includes(rawInput.trim())) return { kind: 'success', text: usage };
    const signal = AbortSignal.any([lifecycle.signal, requestSignal]);
    let key, evidence;
    const phases = new Set();
    const track = promise => { phases.add(promise); return promise; };
    try {
      const spec = parseRequest(rawInput);
      signal.throwIfAborted();
      if (ctx.subagents.rootOf(agent) !== agent) throw new Error('Start /boost from a root session.');
      const cwd = await ctx.workingDirectory.ensure(agent, signal);
      const target = await ctx.fs.resolve(cwd, { signal });
      if (busy.has(target.targetKey)) throw new Error('Another Boost run owns this workspace.');
      key = target.targetKey; busy.add(key);
      const child = (role, prompt, arm) => track(runChild(ctx, { role, parent: agent, cwd, prompt, signal, arm }));
      // Fail early on an unavailable parent evidence tool, before editing files.
      for (const tool of ['bash', 'read']) if (!ctx.tools.executable(tool, agent)) throw new Error(`Parent preset must allow the native ${tool} tool.`);
      const res = await runBoost({ task: spec.task, signal,
        runWorker: prompt => child('worker', `${prompt}\nWork in the shared workspace. Use your allowed local tools to carry out the requested task. The review will sample: ${JSON.stringify(spec.files)}. The human's acceptance check is: ${JSON.stringify(spec.command)}.`),
        getEvidence: () => track(collectEvidence(ctx, agent, { ...spec, cwd }, signal).then(result => { evidence = result; return JSON.stringify(result); })),
        runReviewer: (prompt, reveal) => child('reviewer', prompt, id => armReveal(id, reveal)),
      });
      return { kind: evidence.check.exitCode === 0 ? 'success' : 'error', text: [
        summarizeCheck(evidence.check), `Files sampled: ${spec.files.join(', ')}`,
        `Initial verdict (before worker report was revealed)\n${res.initialVerdict}`, `Final comparison\n${res.finalVerdict}`,
        `Worker report (disclosed only after initial verdict)\n${res.workerReport}`,
      ].join('\n\n') };
    } catch (error) {
      const lockedInitialVerdict = typeof error?.initialVerdict === 'string' && error.initialVerdict.length > 0
        ? error.initialVerdict : undefined;
      return { kind: 'error', text: [`Boost ${signal.aborted ? 'cancelled' : 'did not complete'}: ${error instanceof Error ? error.message : String(error)}`,
        lockedInitialVerdict && `Initial verdict (locked; delivery of the worker report was not confirmed)\n${lockedInitialVerdict}`,
        lockedInitialVerdict && 'The comparison is incomplete. No final comparison was produced.',
        evidence && summarizeCheck(evidence.check), 'No automatic rollback. Check the workspace diff before retrying.'].filter(Boolean).join('\n\n') };
    } finally {
      // Protocol rejects promptly on cancellation; retain ownership until its
      // in-flight tool batch or activation has finished releasing resources.
      await Promise.allSettled([...phases]);
      if (key !== undefined) busy.delete(key);
    }
  }
}
