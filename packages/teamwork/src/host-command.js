/**
 * `/teamwork` command layer.
 *
 * The command is deliberately foreground-only: a human confirmation starts one
 * run in this turn, and the handler returns when the run pauses, is cancelled,
 * or reaches a terminal state. State lives in the campaign store, not in this
 * module; the in-process map only lets another command abort a live run.
 */

import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { parseTeamworkInput, matchesConfirmLine, isValidRunId, USAGE } from './host-input.js'
import { executeCampaign } from './host-runner.js'
import { bounded } from './host-text.js'

const HELP = USAGE
const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const PAUSED = 'paused'

function ok(text) {
  return { kind: 'success', text }
}

function bad(text) {
  return { kind: 'error', text }
}

function short(text, max = 1800) {
  return bounded(String(text ?? ''), max)
}

function acceptanceRecord(state) {
  // An audit failure must not be hidden by an earlier successful check: the
  // audit's own fresh acceptance evidence wins when present.
  const audit = state.audit?.evidence
  const latest = state.evidence?.latest?.check ?? state.evidence?.latest
  const check = audit && Number.isInteger(audit.exitCode) ? audit : latest
  return check && Number.isInteger(check.exitCode) ? check : null
}

export function acceptanceView(state) {
  const check = acceptanceRecord(state)
  if (!check) return ''
  return `acceptance exit ${check.exitCode}${check === state.audit?.evidence ? ' (audited)' : ''}`
}

function statusLine(state) {
  const tasks = state.plan?.tasks ?? []
  const done = tasks.filter(task => task.status === 'pass').length
  return [
    `run ${state.runId}`,
    `status ${state.status}`,
    `mode ${state.mode} route ${state.route}`,
    `cwd ${state.cwd}`,
    `revision ${state.revision}`,
    `tasks ${done}/${tasks.length} passed`,
    `open issues ${state.ledger?.open?.length ?? 0}`,
    state.audit?.status ? `audit ${state.audit.status}` : '',
    acceptanceView(state),
    state.lock ? `lease ${state.lock.ownerId}` : 'lease none',
  ].filter(Boolean).join(' · ')
}

function draftBlock(handle) {
  const state = handle.state
  const draft = state.interview?.draft
  if (!draft) {
    return [
      `run ${state.runId} is in the interview (status ${state.status}).`,
      'Answer with: /teamwork answer <runId> <key> <value>',
      'Keys: objective, users, restrictions, deliverables, constraints, acceptance, route, workdir',
    ].join('\n')
  }
  return [
    draft.text,
    '',
    'Nothing runs until the human types this exact line in a separate chat message:',
    `/teamwork ${draft.confirmLine}`,
    `(run ${state.runId}; token ${draft.token}; version ${draft.version})`,
  ].join('\n')
}

function nextQuestions(interview, state) {
  const steps = Array.isArray(interview?.INTERVIEW_STEPS) ? interview.INTERVIEW_STEPS : []
  const answers = state.interview?.answers ?? {}
  return steps
    .filter(step => step.required && !answers[step.key])
    .map(step => `- ${step.key}: ${step.prompt}`)
}

function summarizeRun(handle, extra = '') {
  const state = handle.state
  const lines = [statusLine(state)]
  if (state.failure?.reason) lines.push(`failure: ${short(state.failure.reason, 600)}`)
  if (state.audit?.status && state.audit.status !== 'not-required') {
    lines.push(`audit: ${state.audit.status} (phases ${JSON.stringify(state.audit.phases ?? {})})`)
  }
  const acceptance = acceptanceRecord(state)
  if (acceptance?.command) {
    lines.push(`last acceptance: exit ${acceptance.exitCode} — ${acceptance.command}${acceptance === state.audit?.evidence ? ' (audited)' : ''}`)
  }
  if (extra) lines.push('', extra)
  return lines.join('\n')
}

export function apply(ctx, modules) {
  if (!ctx?.commands?.register) throw new Error('host-command: ctx.commands.register is required')
  const active = new Map() // runId -> { controller }
  const workspaces = new Map() // canonical cwd key -> runId created by this process
  const reservations = new Map() // canonical cwd key -> { rootId, at }
  const starting = new Set() // root/run keys reserved synchronously before any await
  const RESERVATION_MS = 120_000
  const pending = new Set()
  const lifecycle = new AbortController()
  // Persistent index recovered once per Host process, after the store opens and
  // before the first command is served. It exists because campaign.findByCwd
  // only sees active runs and createCampaign keys each run by runId/rootKey, so
  // a saved draft would otherwise be invisible to no-argument status.
  const recoveredRoots = new Map() // rootSessionId -> most recent non-terminal runId
  const manualRecovery = new Set() // runIds paused by restart recovery
  const recoveryWarnings = []
  let recovered = false

  const workspaceKeyFor = async cwd => {
    try {
      const target = await ctx.fs.resolve(cwd)
      const canonical = ctx.fs.processPath(target)
      return String(target?.targetKey ?? canonical).replace(/[\\/]+$/u, '') || canonical
    } catch {
      return String(cwd).replace(/[\\/]+$/u, '') || String(cwd)
    }
  }

  const recoverStore = async store => {
    if (recovered) return
    const mods = await loadModules()
    const entries = await store.entries()
    const candidates = entries
      .filter(([, state]) => state && typeof state === 'object' && typeof state.runId === 'string' && !TERMINAL.has(state.status))
      .sort((a, b) => (Number(b[1].updatedAt) || 0) - (Number(a[1].updatedAt) || 0))
    const seenWorkspace = new Set()
    for (const [key, saved] of candidates) {
      let state = saved
      if (state.status === 'running' || state.status === 'verifying') {
        // A writing worker cannot survive a process restart. Campaign turns these
        // into paused runs with RESTART_REQUIRES_MANUAL; never dispatch here.
        manualRecovery.add(state.runId)
        try {
          const handle = await mods.campaign.loadCampaign(ctx, key, { store })
          if (handle) {
            const out = await handle.reduce({ type: 'recover', expectedRevision: handle.state.revision })
            const result = out?.result ?? out ?? {}
            if (result.ok === false) {
              recoveryWarnings.push(`${state.runId}: recover rejected (${result.code ?? 'INVALID'}); left paused for manual recovery`)
            } else {
              state = handle.state
            }
          }
        } catch (error) {
          recoveryWarnings.push(`${state.runId}: recover failed (${error instanceof Error ? error.message : String(error)}); left for manual recovery`)
        }
        if (state.status === 'running' || state.status === 'verifying') {
          // Even if the campaign rejected the mutation, this process must not
          // dispatch the run. Status exposes the manual-recovery marker.
          manualRecovery.add(saved.runId)
        }
      }
      if (!state?.cwd || typeof state.runId !== 'string') continue
      const workspace = await workspaceKeyFor(state.cwd)
      if (!seenWorkspace.has(workspace)) {
        seenWorkspace.add(workspace)
        workspaces.set(workspace, state.runId)
      }
      const owner = state.rootSessionId
      if (typeof owner === 'string' && owner && !recoveredRoots.has(owner)) {
        recoveredRoots.set(owner, state.runId)
      }
    }
    recovered = true
  }

  // The storage domain is opened once per command instance. Campaign opens a
  // store per call otherwise, and a JSON domain refuses a second open. Opening
  // is also the startup recovery barrier: commands await this promise, so no
  // handler observes the store before the persistent index is rebuilt.
  let sharedStore
  const storeFor = async () => {
    if (!sharedStore) {
      sharedStore = (async () => {
        let store
        try {
          const module = await import('./store.js')
          store = await module.openStore(ctx)
          await recoverStore(store)
        } catch (error) {
          if (store) await store.close().catch(() => {})
          sharedStore = null
          recovered = false
          throw error
        }
        return store
      })()
    }
    return sharedStore
  }

  const loadModules = async () => {
    if (modules?.campaign) return modules
    const campaign = await import('./campaign.js')
    const interview = await import('./interview.js')
    const dossier = await import('./dossier.js').catch(() => null)
    return { campaign, interview, dossier }
  }

  const signalFor = invocation => {
    const request = invocation.signal
    if (lifecycle.signal.aborted) return lifecycle.signal
    if (!request) return lifecycle.signal
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([lifecycle.signal, request]) : request
  }

  const rootAgent = invocation => {
    const agent = invocation.agent
    if (!agent || !ctx.subagents?.rootOf) return agent
    return ctx.subagents.rootOf(agent)
  }

  // The identity used for in-process mutual exclusion. `processPath` is the
  // host-facing absolute path; `targetKey` is the filesystem service's
  // canonical identity, so symlinked or differently spelled paths share it.
  const canonicalWorkspace = async (root, requested, signal) => {
    let value = requested
    if (!value) value = await ctx.workingDirectory.ensure(root, signal)
    const target = await ctx.fs.resolve(value, { signal })
    const cwd = ctx.fs.processPath(target)
    const key = String(target?.targetKey ?? cwd).replace(/[\\/]+$/u, '') || cwd
    return { cwd, key }
  }

  // Compare a user-supplied directory with the campaign's creation-time cwd.
  // Both the filesystem identity and the normalized host path are considered,
  // so an alias of the same directory is accepted and normalized, while a
  // genuinely different directory is rejected before any state mutation.
  const sameWorkspaceDirectory = async (requested, base, signal) => {
    const target = await ctx.fs.resolve(requested, { cwd: base, signal })
    const requestedPath = ctx.fs.processPath(target)
    const requestedKey = String(target?.targetKey ?? requestedPath).replace(/[\\/]+$/u, '') || requestedPath
    const anchorTarget = await ctx.fs.resolve(base, { cwd: base, signal })
    const anchorPath = ctx.fs.processPath(anchorTarget)
    const anchorKey = String(anchorTarget?.targetKey ?? anchorPath).replace(/[\\/]+$/u, '') || anchorPath
    if (requestedKey === anchorKey) return true
    const normalize = value => {
      let resolved = resolvePath(value)
      if (resolved.length > 1) resolved = resolved.replace(/[\\/]+$/u, '')
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    }
    return normalize(requestedPath) === normalize(anchorPath)
  }

  const workdirRejectedText = (raw, cwd) => (
    `workdir ${raw} is outside this run's workspace ${cwd}. `
    + `The directory is fixed when the run is created; create a new run with @cwd ${raw} instead.`
  )

  const startClaim = keys => {
    const wanted = [...new Set(keys.filter(Boolean))]
    if (wanted.some(key => starting.has(key))) return null
    for (const key of wanted) starting.add(key)
    return () => { for (const key of wanted) starting.delete(key) }
  }

  const reserveCwd = (key, rootId) => {
    const now = Date.now()
    for (const [candidate, entry] of reservations) {
      if (now - entry.at > RESERVATION_MS) reservations.delete(candidate)
    }
    if (reservations.size >= 32) return { error: 'Too many teamwork drafts are being created at once.' }
    if (reservations.has(key)) return { error: 'A teamwork run is already being created in this workspace. Wait for its draft, then confirm or cancel it.' }
    reservations.set(key, { rootId, at: now })
    return { release: () => reservations.delete(key) }
  }

  const implicitMiss = 'No teamwork run is associated with this session or workspace.'

  const resolveRun = async (mods, invocation, wanted) => {
    const root = rootAgent(invocation)
    if (!root?.id) return { error: 'This command needs a root session.' }
    if (invocation.agent !== root) return { error: 'Only the root session may address a teamwork run.' }
    const store = await storeFor()
    let handle = null
    if (wanted) {
      if (!isValidRunId(wanted)) return { error: `Invalid run id: ${wanted}` }
      handle = await mods.campaign.loadCampaign(ctx, wanted, { store })
      if (!handle) return { error: `No teamwork run ${wanted}.` }
      const owner = handle.state?.rootSessionId
      if (owner !== root.id) return { error: `Run ${wanted} belongs to another root session.` }
      return { handle, root }
    }

    // Implicit recovery is owner-scoped. Another root's run in the same cwd is
    // never adopted, listed, or aborted by this session.
    handle = await mods.campaign.loadCampaign(ctx, root.id, { store })
    if (handle && handle.state?.rootSessionId && handle.state.rootSessionId !== root.id) handle = null
    if (!handle) {
      let workspace = null
      try {
        workspace = await canonicalWorkspace(root, null, invocation.signal)
      } catch {
        workspace = null
      }
      if (workspace) {
        const known = workspaces.get(workspace.key)
        if (known) {
          const candidate = await mods.campaign.loadCampaign(ctx, known, { store })
          if (candidate?.state?.rootSessionId === root.id) handle = candidate
        }
        if (!handle) {
          const busy = await mods.campaign.cwdBusy(ctx, workspace.cwd, { store })
          if (busy?.busy && busy.run.state?.rootSessionId === root.id) {
            handle = await mods.campaign.loadCampaign(ctx, busy.run.runId, { store })
          }
        }
      }
      // After a restart a draft may be saved outside the current workspace (or
      // the process may run from a fresh cwd). Prefer the most recent
      // non-terminal run owned by this root, but never adopt a missing owner.
      if (!handle) {
        const latest = recoveredRoots.get(root.id)
        if (latest) {
          const candidate = await mods.campaign.loadCampaign(ctx, latest, { store })
          if (candidate?.state?.rootSessionId === root.id) handle = candidate
        }
      }
    }
    if (!handle) return { error: implicitMiss }
    return { handle, root }
  }

  const runCampaign = async (mods, invocation, handle, root) => {
    const state = handle.state
    if (active.has(state.runId)) {
      return bad(`Run ${state.runId} is already executing in this process. Pause or cancel it instead of starting a second loop.`)
    }
    const leaseToken = `host:${root.id}`
    const controller = new AbortController()
    const onAbort = () => controller.abort(invocation.signal?.reason ?? new Error('Request aborted'))
    invocation.signal?.addEventListener('abort', onAbort, { once: true })
    const acquired = await handle.acquireLease({ ownerId: root.id, ttlMs: state.policy?.leaseMs })
    if (acquired?.result?.ok === false) {
      invocation.signal?.removeEventListener('abort', onAbort)
      return bad(`Could not acquire the workspace lease: ${acquired.result.reason ?? acquired.result.code}`)
    }
    // The turn may have been interrupted while the lease transact was waiting.
    // Never dispatch a child after that point.
    if (invocation.signal?.aborted) {
      invocation.signal.removeEventListener('abort', onAbort)
      await handle.releaseLease({ ownerId: root.id }).catch(() => {})
      return bad('The request was aborted before any child started; nothing was dispatched.')
    }
    const entry = { controller, handle }
    active.set(state.runId, entry)
    try {
      const result = await executeCampaign({
        ctx,
        handle,
        agent: root,
        cwd: state.cwd,
        signal: AbortSignal.any([controller.signal, invocation.signal].filter(Boolean)),
        runId: state.runId,
        leaseToken: acquired?.state?.lock?.token ?? leaseToken,
        control: entry,
      })
      const status = result.status
      const heading = status === 'paused'
        ? 'Teamwork paused. The workspace is NOT rolled back; resume deliberately with /teamwork resume.'
        : status === 'cancelled'
          ? 'Teamwork cancelled.'
          : status === 'terminal'
            ? 'Teamwork reached a terminal state.'
            : 'Teamwork run finished this pass.'
      return ok(`${heading}\n\n${short(result.summary, 6000)}`)
    } finally {
      invocation.signal?.removeEventListener('abort', onAbort)
      active.delete(state.runId)
      await handle.releaseLease({ ownerId: root.id }).catch(() => {})
    }
  }

  const createRun = async (mods, invocation, input) => {
    const { campaign, interview } = mods
    const root = rootAgent(invocation)
    if (!root?.id) return bad('This command needs a root session.')
    if (invocation.agent !== root) return bad('Start a teamwork run from the root session, not a child agent.')
    const signal = signalFor(invocation)

    let workspace
    try {
      workspace = await canonicalWorkspace(root, input.cwd, signal)
    } catch (error) {
      const label = input.cwd ? `@cwd ${input.cwd}` : 'the session workspace'
      return bad(`Cannot resolve ${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const { cwd, key } = workspace

    // Synchronous reservation: two drafts targeting the same canonical cwd must
    // not both pass the asynchronous cwdBusy/create steps. The reservation is
    // released once this handler is done with creation (success or failure).
    const reservation = reserveCwd(key, root.id)
    if (reservation.error) return bad(reservation.error)
    try {
      const busy = await campaign.cwdBusy(ctx, cwd, { store: await storeFor() })
      if (busy?.busy) {
        return bad(`A teamwork run is already active in this workspace: ${busy.run.runId} (status ${busy.run.status}).`)
      }
      // cwdBusy only sees running/verifying/paused runs; known drafts are held
      // in this process, keyed by the canonical workspace identity.
      const known = workspaces.get(key)
      if (known) {
        const existing = await campaign.findByRunId(ctx, known, { store: await storeFor() }).catch(() => null)
        if (existing && !TERMINAL.has(existing.state.status)) {
          return bad(`A teamwork run is already open in this workspace: ${existing.state.runId} (status ${existing.state.status}).`)
        }
        workspaces.delete(key)
      }

      for (const file of input.files ?? []) {
        if (/^(?:[a-zA-Z]:[\\/]|\/|\.\.(?:[\\/]|$))/u.test(file)) {
          return bad(`@file must be a relative path inside the workspace: ${file}`)
        }
        try {
          const target = await ctx.fs.resolve(file, { cwd, signal })
          if (!ctx.fs.contains(await ctx.fs.resolve(cwd, { signal }), target)) {
            return bad(`@file escapes the workspace: ${file}`)
          }
        } catch (error) {
          return bad(`Cannot resolve @file ${file}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const runId = `tw-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 6)}`
      const fullAnswers = {
        objective: input.task,
        users: 'the operator running /teamwork',
        restrictions: 'e',
        deliverables: 'working implementation in the workspace plus reproducible acceptance evidence',
        constraints: 'Follow the confirmed original request exactly; do not push, change the profile, use the browser, or delegate further.',
        acceptance: input.command,
        route: input.mode,
        workdir: cwd,
      }
      const partialAnswers = {
        objective: input.task,
        acceptance: input.command,
        route: input.mode,
        workdir: cwd,
      }

      let handle
      try {
        handle = await campaign.createCampaign(ctx, {
          mode: input.mode,
          cwd,
          rootSessionId: root.id,
          runId,
          confirmedCommand: input.command,
          originalRequest: input.task,
          files: [...(input.files ?? [])],
          skipInterview: input.skip === true,
          answers: input.skip === true ? fullAnswers : partialAnswers,
        }, { rootKey: runId, store: await storeFor() })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return bad(`Could not create the teamwork run: ${short(message, 1200)}\n\n${HELP}`)
      }
      workspaces.set(key, handle.state.runId)
      recoveredRoots.set(root.id, handle.state.runId)

      if (handle.state.status === 'awaiting-confirm' && handle.state.interview?.draft) {
        return ok(`${draftBlock(handle)}\n\nNo child has started.`)
      }
      const questions = nextQuestions(interview, handle.state)
      return ok([
        `run ${handle.state.runId} created in interview (status ${handle.state.status}).`,
        'No child starts until the draft is confirmed in a separate chat message.',
        '',
        'Next questions:',
        ...questions,
        '',
        'Answer one key at a time: /teamwork answer <runId> <key> <value>',
      ].join('\n'))
    } finally {
      reservation.release()
    }
  }

  const dispatch = async (invocation, parsed) => {
    const mods = await loadModules()
    const { campaign } = mods
    switch (parsed.kind) {
      case 'help':
        return ok(HELP)
      case 'list': {
        const root = rootAgent(invocation)
        if (!root?.id || invocation.agent !== root) return bad('Only the root session may list teamwork runs.')
        if (typeof campaign.findByCwd !== 'function') return bad('Listing runs is not available in this build.')
        const workspace = await canonicalWorkspace(root, null, signalFor(invocation))
        const runs = await campaign.findByCwd(ctx, workspace.cwd, { store: await storeFor() })
        const owned = runs.filter(run => run.state?.rootSessionId === root.id)
        if (!owned.length) return ok('No active teamwork run owned by this session in this workspace.')
        return ok(owned.map(run => `${run.runId} · ${run.status}`).join('\n'))
      }
      case 'dossier': {
        const resolved = await resolveRun(mods, invocation, parsed.runId)
        if (resolved.error) return bad(resolved.error)
        const render = mods.dossier?.renderDossier
        if (typeof render !== 'function') return bad('The dossier renderer is not installed.')
        return ok(short(render(resolved.handle.state), 12000))
      }
      case 'status': {
        const resolved = await resolveRun(mods, invocation, parsed.runId)
        if (resolved.error) return bad(resolved.error)
        const state = resolved.handle.state
        const extras = []
        if (state.interview?.draft && state.status === 'awaiting-confirm') {
          extras.push(`Awaiting the exact line: /teamwork ${state.interview.draft.confirmLine}`)
        }
        if (manualRecovery.has(state.runId) || state.failure?.code === 'RESTART_REQUIRES_MANUAL') {
          extras.push('Recovery: this run was running when the Host restarted. It is paused BEFORE any automatic dispatch and requires a manual /teamwork resume.')
        }
        const recoveryWarning = recoveryWarnings.find(item => item.startsWith(`${state.runId}:`))
        if (recoveryWarning) extras.push(`Recovery note: ${recoveryWarning}`)
        return ok(summarizeRun(resolved.handle, extras.join('\n\n')))
      }
      case 'answer': {
        const resolved = await resolveRun(mods, invocation, parsed.runId)
        if (resolved.error) return bad(resolved.error)
        const handle = resolved.handle
        const values = { ...(parsed.values ?? {}) }
        if (Object.prototype.hasOwnProperty.call(values, 'workdir')
          && String(values.workdir ?? '').trim() !== '') {
          const raw = String(values.workdir).trim()
          let same = false
          try {
            same = await sameWorkspaceDirectory(raw, handle.state.cwd, signalFor(invocation))
          } catch (error) {
            return bad(`Answer rejected (WORKDIR_UNRESOLVED): ${error instanceof Error ? error.message : String(error)}\nNo answer accepted; the draft is unchanged.`)
          }
          if (!same) {
            return bad(`Answer rejected (WORKDIR_MISMATCH): ${workdirRejectedText(raw, handle.state.cwd)}\nNo answer accepted; the draft is unchanged.`)
          }
          values.workdir = handle.state.cwd
        }
        const result = await handle.reduce({
          type: 'interview-answer',
          values,
          expectedRevision: handle.state.revision,
        })
        const out = result?.result ?? result ?? {}
        if (out.ok === false) {
          const rejected = (out.rejected ?? []).map(item => `${item.key}: ${item.reason}`).join('; ')
          return bad(`Answer rejected (${out.code ?? 'INVALID'}): ${rejected || out.reason || 'unknown reason'}`)
        }
        if (handle.state.status === 'awaiting-confirm' && handle.state.interview?.draft) {
          return ok(draftBlock(handle))
        }
        const questions = nextQuestions(mods.interview, handle.state)
        const rejected = (out.rejected ?? []).map(item => `${item.key}: ${item.reason}`)
        return ok([
          `Accepted: ${(out.accepted ?? []).join(', ') || 'none'}`,
          ...(rejected.length ? [`Rejected: ${rejected.join('; ')}`] : []),
          ...(questions.length ? ['', 'Next questions:', ...questions] : ['', 'All required answers received.']),
        ].join('\n'))
      }
      case 'confirm': {
        const root = rootAgent(invocation)
        if (!root?.id) return bad('This command needs a root session.')
        const releaseClaim = startClaim([`root:${root.id}`, parsed.runId ? `run:${parsed.runId}` : null])
        if (!releaseClaim) return bad('Another teamwork run is already starting for this session. Wait for it to pause, finish, or fail.')
        try {
          const resolved = await resolveRun(mods, invocation, parsed.runId)
          if (resolved.error) return bad(resolved.error)
          const handle = resolved.handle
          const state = handle.state
          if (state.status !== 'awaiting-confirm' || !state.interview?.draft) {
            return bad(`Run ${state.runId} is ${state.status}, not awaiting confirmation. No child started.`)
          }
          if (!matchesConfirmLine(parsed.text, state.interview.draft.confirmLine)) {
            return bad(`Confirmation does not match. Type the draft line exactly, token included:\n/teamwork ${state.interview.draft.confirmLine}\nNo child started.`)
          }
          const draft = state.interview.draft
          const draftWorkdir = String(draft.workdir ?? '').trim()
          if (!draftWorkdir) {
            return bad(`Confirmation rejected (WORKDIR_MISMATCH): the draft has no workdir. Create a new run with @cwd ${state.cwd}.\nNo child started.`)
          }
          let sameWorkdir = false
          try {
            sameWorkdir = await sameWorkspaceDirectory(draftWorkdir, state.cwd, signalFor(invocation))
          } catch (error) {
            return bad(`Confirmation rejected (WORKDIR_UNRESOLVED): ${error instanceof Error ? error.message : String(error)}\nNo child started.`)
          }
          if (!sameWorkdir) {
            return bad(`Confirmation rejected (WORKDIR_MISMATCH): ${workdirRejectedText(draftWorkdir, state.cwd)}\nNo child started.`)
          }
          if (draft.workdir !== state.cwd) {
            // Older drafts may spell an equivalent directory differently
            // (symlink, trailing slash, casing).  Persist the canonical
            // creation-time cwd through the reducer and require the human to
            // type the rebuilt line: the old token commits to the old spelling,
            // so silently starting from it would execute a spec the human did
            // not see.
            const normalized = await handle.reduce({
              type: 'interview-answer',
              values: { workdir: state.cwd },
              expectedRevision: state.revision,
            })
            const applied = normalized?.result ?? normalized ?? {}
            if (applied.ok === false) {
              return bad(`Confirmation rejected (${applied.code ?? 'INVALID'}): ${applied.reason ?? 'no reason'}\nNo child started.`)
            }
            const nextDraft = handle.state.interview?.draft
            if (!nextDraft) {
              return bad('Confirmation rejected (WORKDIR_MISMATCH): the normalized draft is unavailable. No child started.')
            }
            return bad([
              `Draft normalized from ${draftWorkdir} to the creation-time workspace ${state.cwd}.`,
              'The old line is no longer current. Type the rebuilt line exactly:',
              `/teamwork ${nextDraft.confirmLine}`,
              'No child started.',
            ].join('\n'))
          }
          const result = await handle.reduce({
            type: 'confirm',
            text: draft.confirmLine,
            token: draft.token,
            version: draft.version,
            source: 'manual-chat',
            expectedRevision: state.revision,
          })
          const out = result?.result ?? result ?? {}
          if (out.ok === false) {
            return bad(`Confirmation rejected (${out.code ?? 'INVALID'}): ${out.reason ?? 'no reason'}\nNo child started.`)
          }
          return await runCampaign(mods, invocation, handle, resolved.root)
        } finally {
          releaseClaim()
        }
      }
      case 'pause': {
        const resolved = await resolveRun(mods, invocation, parsed.runId)
        if (resolved.error) return bad(resolved.error)
        const handle = resolved.handle
        if (TERMINAL.has(handle.state.status)) return bad(`Run ${handle.state.runId} is already ${handle.state.status}.`)
        const result = await handle.reduce({ type: 'pause', source: 'manual-chat', reason: 'paused by root session' })
        const out = result?.result ?? result ?? {}
        if (out.ok === false) return bad(`Pause rejected (${out.code ?? 'INVALID'}): ${out.reason ?? 'no reason'}`)
        active.get(handle.state.runId)?.controller.abort(new Error('Paused by user'))
        return ok(`Paused ${handle.state.runId}. State is durable; resume with /teamwork resume ${handle.state.runId}.`)
      }
      case 'resume': {
        const root = rootAgent(invocation)
        if (!root?.id) return bad('This command needs a root session.')
        const releaseClaim = startClaim([`root:${root.id}`, parsed.runId ? `run:${parsed.runId}` : null])
        if (!releaseClaim) return bad('Another teamwork run is already starting for this session. Wait for it to pause, finish, or fail.')
        try {
          const resolved = await resolveRun(mods, invocation, parsed.runId)
          if (resolved.error) return bad(resolved.error)
          const handle = resolved.handle
          if (handle.state.status !== PAUSED) return bad(`Run ${handle.state.runId} is ${handle.state.status}; only a paused run can resume.`)
          if (active.has(handle.state.runId)) {
            return bad(`Run ${handle.state.runId} is still stopping from its previous pass. Wait for it to settle, then resume again.`)
          }
          const result = await handle.reduce({ type: 'resume', source: 'manual-chat', expectedRevision: handle.state.revision })
          const out = result?.result ?? result ?? {}
          if (out.ok === false) return bad(`Resume rejected (${out.code ?? 'INVALID'}): ${out.reason ?? 'no reason'}`)
          manualRecovery.delete(handle.state.runId)
          recoveredRoots.set(resolved.root.id, handle.state.runId)
          return await runCampaign(mods, invocation, handle, resolved.root)
        } finally {
          releaseClaim()
        }
      }
      case 'cancel': {
        const resolved = await resolveRun(mods, invocation, parsed.runId)
        if (resolved.error) return bad(resolved.error)
        const handle = resolved.handle
        if (TERMINAL.has(handle.state.status)) return bad(`Run ${handle.state.runId} is already ${handle.state.status}.`)
        const result = await handle.reduce({ type: 'cancel', source: 'manual-chat', reason: 'cancelled by root session', expectedRevision: handle.state.revision })
        const out = result?.result ?? result ?? {}
        if (out.ok === false) return bad(`Cancel rejected (${out.code ?? 'INVALID'}): ${out.reason ?? 'no reason'}`)
        active.get(handle.state.runId)?.controller.abort(new Error('Cancelled by user'))
        return ok(`Cancelled ${handle.state.runId}. The workspace was not rolled back.`)
      }
      case 'new':
        return createRun(mods, invocation, parsed)
      case 'error':
        return bad(`${parsed.message}\n\n${HELP}`)
      default:
        return bad(`Unknown teamwork command.\n\n${HELP}`)
    }
  }

  const handler = invocation => {
    const operation = (async () => {
      const parsed = parseTeamworkInput(invocation.rawInput)
      try {
        return await dispatch(invocation, parsed)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return bad(`Teamwork command failed: ${short(message, 2000)}`)
      }
    })()
    pending.add(operation)
    return operation.finally(() => pending.delete(operation))
  }

  const dispose = ctx.commands.register({
    definitionId: 'dk-teamwork-command',
    name: 'teamwork',
    description: 'Evidence-gated implementation team with explicit human confirmation; /teamwork help for usage.',
    input: {
      hint: '[skip] --mode swe-light|general <task> · status|dossier [runId] · confirm <runId> <token> · answer · pause · resume · cancel · list',
    },
    handler,
  })

  ctx.effect(() => async () => {
    lifecycle.abort(new Error('Teamwork command disposed'))
    for (const entry of active.values()) entry.controller.abort(new Error('Teamwork command disposed'))
    await Promise.allSettled([...pending])
    if (sharedStore) await sharedStore.then(store => store.close()).catch(() => {})
  })

  return dispose
}
