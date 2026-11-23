import { randomUUID } from 'node:crypto';

// The reserved id lets the reviewer claim its capability even if its first
// step starts before startActivation returns. No permanent name/capability.
export async function runChild(ctx, { role, parent, cwd, prompt, signal, arm }) {
  signal.throwIfAborted();
  const childId = randomUUID();
  const disarm = arm?.(childId);
  try {
    const handle = await ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller',
      parent, cwd, signal, childId, maxDepth: ctx.subagents.resolveMaxDepth(),
      label: `Boost ${role}`, agentPreset: `dk-boost-${role}`, prompt: [{ type: 'text', text: prompt }] });
    let disposal;
    const stop = () => { disposal ??= Promise.resolve().then(() => handle.dispose()); disposal.catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
      const result = await handle.result;
      signal.throwIfAborted();
      if (result.stopReason !== 'completed') throw new Error(`${role} stopped (${result.stopReason})${result.diagnostic ? `: ${result.diagnostic}` : ''}`);
      return result.output.filter(b => b.type === 'text').map(b => b.text).join('\n');
    } finally {
      signal.removeEventListener('abort', stop);
      if (disposal) await disposal;
    }
  } finally { disarm?.(); }
}
