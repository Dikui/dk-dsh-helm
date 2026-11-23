import { randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * Evidence collection through the *parent's* registered tools, so the DSH
 * sandbox, guards and approvals still apply. Only the host supplies official
 * acceptance receipts, and no model-generated text is used as the command.
 */

/**
 * @param {object} ctx
 * @param {object} agent
 * @param {AbortSignal} signal
 * @param {string} name
 * @param {object} args
 */
async function call(ctx, agent, signal, name, args) {
  signal.throwIfAborted()
  const id = randomUUID()
  const batch = await ctx.tools.execute({
    agent,
    signal,
    calls: [{ id, type: 'tool-call', name, arguments: JSON.stringify(args) }],
  })
  const item = batch.results.find(entry => entry.callId === id)?.result
  if (!item || item.isError) {
    throw new Error(`${name}: ${item?.content?.find(block => block.type === 'text')?.text ?? 'tool unavailable'}`)
  }
  return item
}

/**
 * Run the user-confirmed acceptance command in the foreground and sample the
 * listed files. Any non-usable exit status is an error, never a pass.
 *
 * @param {object} ctx
 * @param {object} agent - parent agent; must allow the native bash/read tools.
 * @param {{cwd: string, files?: string[], command: string}} spec
 * @param {AbortSignal} signal
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{check: object, files: object[]}>}
 */
export async function collectTeamworkEvidence(ctx, agent, { cwd, files = [], command }, signal, { timeoutMs = 180000 } = {}) {
  const root = await ctx.fs.resolve(cwd, { signal })
  const checkResult = await call(ctx, agent, signal, 'bash', {
    description: 'Run the human-confirmed Teamwork acceptance check',
    command,
    workdir: cwd,
    timeoutMs,
  })
  const value = checkResult.value
  if (value?.kind !== 'foreground') {
    const job = value?.jobId
    if (job) {
      await call(ctx, agent, AbortSignal.timeout(10000), 'job_kill', {
        job_id: job,
        reason: 'Teamwork requires a completed foreground acceptance check',
      }).catch(error => {
        throw new Error(`Acceptance incomplete; inspect job ${job}: ${error.message}`)
      })
    }
    throw new Error(`Acceptance did not finish in the foreground${job ? `; stop requested for job ${job}` : ''}`)
  }
  if (
    !Number.isInteger(value.exitCode) ||
    value.signal ||
    value.aborted ||
    value.stopped !== undefined ||
    value.timedOut ||
    value.sandbox?.denied ||
    value.sandbox?.runnerFailed
  ) {
    throw new Error('Acceptance did not produce a usable exit status (interrupted, timed out, or sandbox denied)')
  }
  const trimTail = (text = '') => text.slice(-3000)
  const check = {
    command,
    exitCode: value.exitCode,
    stdout: trimTail(value.stdout.text),
    stderr: trimTail(value.stderr.text),
    truncated: Boolean(
      value.stdout.truncated ||
        value.stderr.truncated ||
        value.stdout.text.length > 3000 ||
        value.stderr.text.length > 3000,
    ),
  }
  const snapshots = []
  for (const file of files) {
    const target = await ctx.fs.resolve(file, { cwd, signal })
    if (!ctx.fs.contains(root, target) || path.isAbsolute(file) || file.split(/[\\/]/u).includes('..')) {
      throw new Error(`Evidence outside workspace: ${file}`)
    }
    const result = await call(ctx, agent, signal, 'read', {
      file_path: ctx.fs.processPath(target),
      limit: 120,
    })
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (!text.trim()) throw new Error(`No readable evidence from ${file}`)
    snapshots.push({ file, text: text.slice(0, 6000), clipped: text.length > 6000 })
  }
  return { check, files: snapshots }
}
