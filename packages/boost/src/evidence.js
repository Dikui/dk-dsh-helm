import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Call the *parent's* tools, not a Host shell/file reader. Guards, sandbox and
// user approvals still apply. Missing/conditional/PTC-only tools fail closed.
async function call(ctx, agent, signal, name, args) {
  signal.throwIfAborted();
  const id = randomUUID();
  const batch = await ctx.tools.execute({ agent, signal, calls: [
    { id, type: 'tool-call', name, arguments: JSON.stringify(args) },
  ] });
  const item = batch.results.find(x => x.callId === id)?.result;
  if (!item || item.isError) throw new Error(`${name}: ${item?.content?.find(b => b.type === 'text')?.text ?? 'tool unavailable'}`);
  return item;
}

export async function collectEvidence(ctx, agent, { cwd, files, command }, signal) {
  const root = await ctx.fs.resolve(cwd, { signal });
  const checkResult = await call(ctx, agent, signal, 'bash', { description: 'Run the user-specified Boost acceptance check', command, workdir: cwd, timeoutMs: 120000 });
  const value = checkResult.value;
  if (value?.kind !== 'foreground') {
    const job = value?.jobId;
    if (job) {
      // A deployment may promote slow foreground calls. Do not orphan ongoing checks silently.
      await call(ctx, agent, AbortSignal.timeout(10000), 'job_kill', { job_id: job, reason: 'Boost requires a completed foreground check' })
        .catch(e => { throw new Error(`Check incomplete; inspect job ${job}: ${e.message}`); });
    }
    throw new Error(`Check did not finish in the foreground${job ? `; stop requested for job ${job}` : ''}`);
  }
  if (!Number.isInteger(value.exitCode) || value.signal || value.aborted || value.stopped !== undefined || value.timedOut || value.sandbox?.denied || value.sandbox?.runnerFailed) {
    throw new Error('Check did not produce a usable exit status (interrupted, timed out, or sandbox denied)');
  }
  const tail = (s = '') => s.slice(-3000);
  const check = { command, exitCode: value.exitCode, stdout: tail(value.stdout.text), stderr: tail(value.stderr.text),
    truncated: Boolean(value.stdout.truncated || value.stderr.truncated || value.stdout.text.length > 3000 || value.stderr.text.length > 3000) };
  const snapshots = [];
  for (const file of files) {
    const target = await ctx.fs.resolve(file, { cwd, signal });
    if (!ctx.fs.contains(root, target) || path.isAbsolute(file) || file.split(/[\\/]/u).includes('..')) throw new Error(`Evidence outside workspace: ${file}`);
    const result = await call(ctx, agent, signal, 'read', { file_path: ctx.fs.processPath(target), limit: 120 });
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!text.trim()) throw new Error(`No readable evidence from ${file}`);
    snapshots.push({ file, text: text.slice(0, 6000), clipped: text.length > 6000 });
  }
  return { check, files: snapshots };
}
