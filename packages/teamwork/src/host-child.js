import { randomUUID } from 'node:crypto'

/**
 * Spawn one fresh teamwork child with its role preset.
 *
 * The child id is the durable session
 * id, so campaign role-started/result identity checks stay meaningful.
 *
 * @param {object} ctx - plugin context.
 * @param {object} options
 * @param {string} options.role - campaign role.
 * @param {string} options.preset - agent preset id (dk-teamwork-*).
 * @param {object} options.parent - root agent starting the command.
 * @param {string} options.cwd
 * @param {string} options.prompt
 * @param {AbortSignal} options.signal
 * @param {string} [options.childId] - pre-generated session id recorded by the campaign.
 * @returns {Promise<string>} child's final text.
 */
export async function runTeamworkChild(ctx, { role, preset, parent, cwd, prompt, signal, childId }) {
  signal.throwIfAborted()
  const id = childId ?? randomUUID()
  const handle = await ctx.subagents.startActivation({
    provider: 'spawn',
    delivery: 'caller',
    parent,
    cwd,
    signal,
    childId: id,
    maxDepth: ctx.subagents.resolveMaxDepth(),
    label: `Teamwork ${role}`,
    agentPreset: preset,
    prompt: [{ type: 'text', text: prompt }],
  })
  let disposal
  const stop = () => {
    disposal ??= Promise.resolve().then(() => handle.dispose())
    disposal.catch(() => {})
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const result = await handle.result
    signal.throwIfAborted()
    if (result.stopReason !== 'completed') {
      throw new Error(`${role} stopped (${result.stopReason})${result.diagnostic ? `: ${result.diagnostic}` : ''}`)
    }
    return result.output.filter(block => block.type === 'text').map(block => block.text).join('\n')
  } finally {
    signal.removeEventListener('abort', stop)
    if (disposal) await disposal
  }
}
