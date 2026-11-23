import { randomUUID } from 'node:crypto';
import {
  HostError,
  asHostError,
  byteLength,
  failure,
  oneLine,
  truncateText,
} from './host-format.js';
import { buildPublicView } from './host-view.js';
import { startStallMonitor } from './stall-monitor.js';

const SPAWN_TIMEOUT_MS = 120_000;
const RESERVATION_TTL_MS = 120_000;
const GUARD_INTERVAL_MS = 60_000;

function nowMs() {
  return Date.now();
}

function isQuotaFailure(failureValue) {
  let text;
  try {
    text = JSON.stringify(failureValue);
  } catch {
    text = String(failureValue);
  }
  return /rate.?limit|429|quota|insufficient_quota|resource.?exhausted|too many requests/i.test(
    String(text ?? ''),
  );
}

/**
 * The runtime half of Swarm: membership, native child spawn/compensation,
 * wake delivery, turn guards and the read-only view. Board policy stays in
 * `@local/dk-dsh-swarm`'s core files (`board.js`/`channels.js`).
 */
export class SwarmHost {
  constructor({ ctx, store, state, channels, logger, makeMessage }) {
    this.ctx = ctx;
    this.store = store;
    this.state = state;
    this.channels = channels;
    this.logger = logger;
    this.makeMessage = makeMessage ?? defaultMakeMessage;
    this.lifecycle = new AbortController();
    this.handles = new Map();
    this.retiredActivations = new WeakSet();
    this.inflightAdds = new Map();
    this.drains = new Map();
    // A tool result can be blocked or rewritten after execute() returns. Keep
    // the exact page until tools/result confirms the model saw it.
    this.pendingReads = new Map();
    this.readCommits = new Map();
    this.pendingReadLimit = 512;
    this.remindedSeq = new Map();
    this.recentWakes = new Map();
    this.quotaFailures = new Map();
    this.activated = new Set();
    this.off = [];
    this.interval = null;
    this.disposed = false;
    this.startupReconciled = false;
  }

  log(level, message, error) {
    const logger = this.logger;
    if (!logger) return;
    const fn = logger[level] ?? logger.info;
    if (typeof fn !== 'function') return;
    try {
      fn.call(logger, `[swarm] ${message}`, error);
    } catch {
      // Logging must never break the board.
    }
  }

  async start() {
    await this.state.load();
    this.installEvents();
    this.interval = setInterval(() => {
      this.cleanupReservations().catch((error) => this.log('warn', 'reservation cleanup failed', error));
    }, GUARD_INTERVAL_MS);
    this.interval.unref?.();
    if (typeof startStallMonitor === 'function') {
      const disposer = startStallMonitor({
        list: () => this.state.roots().map((root) => this.state.board(root)).filter(Boolean),
        notify: (rootId, message) => this.steerRoot(rootId, message, 'Swarm stall monitor'),
        onError: (error) => this.log('warn', 'stall monitor', error),
      });
      if (typeof disposer === 'function') this.off.push(disposer);
      else if (disposer && typeof disposer.dispose === 'function') this.off.push(() => disposer.dispose());
    }
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.interval) clearInterval(this.interval);
    this.lifecycle.abort(new Error('swarm host disposed'));
    for (const off of this.off.splice(0)) {
      try {
        off();
      } catch {
        // Ignore a disposer already released by Cordis.
      }
    }
    for (const handle of this.handles.values()) {
      try {
        await handle.dispose?.();
      } catch {
        // Child may already be gone.
      }
    }
    this.handles.clear();
    this.pendingReads.clear();
    this.readCommits.clear();
    await this.store.close();
  }

  installEvents() {
    const on = (name, handler) => {
      if (typeof this.ctx.on !== 'function') return;
      const off = this.ctx.on(name, handler);
      if (typeof off === 'function') this.off.push(off);
      else if (off && typeof off.dispose === 'function') this.off.push(() => off.dispose());
    };
    on('agent/pre-step', (payload, next) => this.preStep(payload, next));
    on('agent/turn-stopping', (payload) => this.turnStopping(payload));
    on('agent/request-error', (payload, next) => this.requestError(payload, next));
    on('agent/disposed', (payload) => this.agentDisposed(payload));
    on('tools/result', (exec, result) => this.observeToolResult(exec, result));
  }

  async preStep(payload, next) {
    const decision = await next();
    const agent = payload?.agent;
    if (!agent || this.disposed || payload?.signal?.aborted) return decision;
    const entry = this.state.resolve(agent);
    if (!entry) return decision;
    if (decision?.kind !== 'enter') return decision;
    const activity = this.unreadActivity(entry);
    if (!activity) return decision;
    try {
      const message = await this.makeMessage(
        this.reminderText(entry, activity),
        `Swarm has ${activity.fresh.length} unread post(s)`,
      );
      // A user cancel must win over a queued reminder.
      if (payload?.signal?.aborted || this.disposed) return decision;
      this.markReminded(agent.id, activity.latest.seq);
      void this.ackUnread(entry, activity.latest.seq).catch((error) =>
        this.log('warn', 'pre-step wake ack failed', error),
      );
      return { ...decision, messages: [message, ...(decision.messages ?? [])] };
    } catch (error) {
      this.log('warn', 'pre-step reminder failed', error);
      return decision;
    }
  }

  async turnStopping(payload) {
    const agent = payload?.agent;
    if (!agent || this.disposed || payload?.signal?.aborted) return;
    const entry = this.state.resolve(agent);
    if (!entry) return;
    // Only a directed mention bounces a park; general chatter is left for the
    // next step reminder or the member's next activation.
    const activity = this.unreadActivity(entry, { directedOnly: true });
    if (!activity || typeof agent.steer !== 'function') return;
    try {
      const message = await this.makeMessage(
        this.reminderText(entry, activity),
        `Swarm mention from seq ${activity.latest.seq}`,
      );
      if (payload?.signal?.aborted || this.disposed) return;
      if (entry.self?.status === 'killed' || entry.self?.status === 'paused') return;
      // nextStep, not nextTurn: the park guard keeps the current turn alive.
      agent.steer(message);
      this.markReminded(agent.id, activity.latest.seq);
      void this.ackUnread(entry, activity.latest.seq).catch((error) =>
        this.log('warn', 'turn-stopping wake ack failed', error),
      );
    } catch (error) {
      this.log('warn', 'turn-stopping reminder failed', error);
    }
  }

  async requestError(payload, next) {
    let stopRetry = false;
    try {
      if (isQuotaFailure(payload?.failure)) {
        const agent = payload?.agent;
        const entry = agent ? this.state.resolve(agent) : null;
        if (entry && !entry.isRoot && entry.self) {
          const count = (this.quotaFailures.get(agent.id) ?? 0) + 1;
          this.quotaFailures.set(agent.id, count);
          if (entry.self.status === 'paused' || entry.self.status === 'killed') {
            // The threshold already parked this member. Do not let an
            // `always` retry policy start it again.
            stopRetry = true;
          } else if (count >= 3) {
            const out = await this.state.act(entry.rootId, entry.rootId, {
              type: 'pause',
              target: entry.self.sessionId,
              reason: 'repeated quota/rate-limit errors',
            });
            if (out.result?.ok) {
              stopRetry = true;
              await this.steerRoot(
                entry.rootId,
                `[Swarm] Paused "${entry.self.name}" after ${count} quota/rate-limit errors. Inspect with /swarm status, then "resume ${entry.self.name}".`,
                'Swarm member paused after quota errors',
              ).catch(() => {});
            } else {
              this.log('warn', `pause ${entry.self.name} failed: ${out.result?.code}`);
            }
          }
        }
      }
    } catch (error) {
      this.log('warn', 'request-error guard failed', error);
    }
    // Exactly once. A failed next() must propagate to the host, not be retried.
    const action = await next();
    // Returning undefined prevents the configured retry policy from running
    // again after the member has been parked.
    if (stopRetry) return undefined;
    return action;
  }

  agentDisposed(payload) {
    const id = payload?.agent?.id;
    if (typeof id === 'string') {
      this.handles.delete(id);
      this.quotaFailures.delete(id);
    }
  }

  /** Register a newly loaded root so pending wakes can be resumed once. */
  async activateRoot(rootAgent) {
    if (!rootAgent || this.activated.has(rootAgent.id)) return;
    this.activated.add(rootAgent.id);
    await this.startupReconcile();
    await this.deliverPending(rootAgent.id).catch((error) =>
      this.log('warn', 'pending wake replay failed', error),
    );
  }

  async startupReconcile() {
    if (this.startupReconciled) return;
    this.startupReconciled = true;
    const live = new Set((this.ctx.agents?.list?.() ?? []).map((agent) => agent.id));
    for (const rootId of this.state.roots()) {
      try {
        const board = this.state.board(rootId);
        // A cold member can be restored by sendMessage and still owns undelivered
        // doorbells. Reconcile must not classify it as dead just because no live
        // Agent exists yet: keep every roster session in the live set so core
        // preserves pending wakes; reservations (not yet members) still expire.
        const keep = new Set(live);
        for (const sessionId of Object.keys(board?.members ?? {})) keep.add(sessionId);
        await this.state.act(rootId, null, {
          type: 'reconcile',
          liveSessionIds: [...keep],
        });
      } catch (error) {
        this.log('warn', `startup reconcile failed for ${rootId}`, error);
      }
    }
  }

  async deliverPending(rootId) {
    const board = this.state.board(rootId);
    if (!board) return;
    const rootAgent = this.state.rootAgent(rootId);
    if (!rootAgent) return;
    const members = new Set(Object.keys(board.members ?? {}));
    const wakes = (board.pendingWakes ?? [])
      .filter((wake) => members.has(wake.sessionId))
      .slice(0, 20)
      .map((wake) => ({ sessionId: wake.sessionId, seq: wake.seq }));
    if (wakes.length > 0) await this.dispatchWakes(rootId, wakes);
  }

  // -------------------------------------------------------------------------
  // Identity helpers
  // -------------------------------------------------------------------------

  resolve(agent) {
    return this.state.resolve(agent);
  }

  ensureRoot(agent) {
    const entry = this.state.resolve(agent);
    if (!entry) throw failure('NOT_MEMBER', 'no swarm here; create one with /swarm init');
    if (!entry.isRoot) {
      throw failure('FORBIDDEN', `only the swarm root can use this; you are member "${entry.self?.name ?? '?'}"`);
    }
    return entry;
  }

  ensureMember(agent) {
    const entry = this.state.resolve(agent);
    if (!entry || !entry.self) throw failure('NOT_MEMBER', 'you are not a member of this swarm');
    if (entry.self.status === 'killed') throw failure('CLOSED', 'this member has been killed');
    if (entry.self.status === 'paused') throw failure('PAUSED', 'this member is paused');
    return entry;
  }

  canUseSwarmTool(agent) {
    const entry = this.state.resolve(agent);
    return Boolean(entry?.isRoot && entry.self?.status !== 'killed');
  }

  canUseSocialTool(agent) {
    const entry = this.state.resolve(agent);
    if (!entry?.self || entry.self.status === 'killed') return false;
    if (entry.isRoot) {
      return Object.values(entry.board.members ?? {}).some(
        (member) => member.role !== 'coordinator' && member.status !== 'killed',
      );
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Native spawn with reserve -> spawn -> commit compensation
  // -------------------------------------------------------------------------

  // An add is admitted for its whole reserve -> spawn -> commit window. finish
  // cancels and drains that window per root before it reports success, so an
  // already-accepted add can never register after the finish returned.
  beginInflightAdd(rootId, sessionId) {
    if (this.drains.has(rootId)) {
      throw failure('BUSY', 'swarm finish is in progress; retry the add after it completes');
    }
    let resolve;
    const done = new Promise((settle) => {
      resolve = settle;
    });
    const guard = {
      rootId,
      sessionId,
      cancelled: false,
      reason: '',
      controller: null,
      disposeError: null,
      done,
      resolve,
    };
    this.inflightAdds.set(sessionId, guard);
    return guard;
  }

  endInflightAdd(guard) {
    if (this.inflightAdds.get(guard.sessionId) === guard) {
      this.inflightAdds.delete(guard.sessionId);
    }
    guard.resolve();
  }

  cancelInflightAdd(guard, reason) {
    if (guard.cancelled) return;
    guard.cancelled = true;
    guard.reason = String(reason ?? 'the board is finishing');
    try {
      guard.controller?.abort(new Error(guard.reason));
    } catch {
      // Abort is advisory; the post-spawn cancellation checks still apply.
    }
  }

  cancelledAdd(guard) {
    return failure('CANCELLED', `swarm add was cancelled: ${guard.reason || 'the board is finishing'}`);
  }

  async failJoin(rootId, reservationId, reason) {
    if (!reservationId) return true;
    try {
      const out = await this.state.act(rootId, rootId, {
        type: 'failJoin',
        reservationId,
        reason: oneLine(reason, 160),
      });
      return out.result?.ok === true || out.result?.code === 'NOT_FOUND';
    } catch (error) {
      this.log('warn', `could not revoke reservation ${reservationId}`, error);
      return false;
    }
  }

  async disposeActivation(activation, { rootId, sessionId } = {}) {
    if (!activation) return { ok: true };
    this.retiredActivations.add(activation);
    try {
      await activation.dispose?.();
      return { ok: true };
    } catch (error) {
      this.log('warn', `could not dispose activation${sessionId ? ` ${sessionId}` : ''}`, error);
      // Interrupt is a weaker fallback: it may stop the child but does not
      // confirm that the activation was disposed.
      try {
        this.ctx.subagents?.interrupt?.(sessionId, {
          kind: 'ancestor',
          agent: this.state.rootAgent(rootId),
        });
      } catch {
        // Nothing else to try; the caller reports the failure.
      }
      return { ok: false, error };
    }
  }

  async failOpenReservations(rootId, reason) {
    const remaining = [];
    const board = this.state.board(rootId);
    for (const reservationId of Object.keys(board?.reservations ?? {})) {
      if (!(await this.failJoin(rootId, reservationId, reason))) remaining.push(reservationId);
    }
    return remaining;
  }

  async runFinish(rootId) {
    const killed = [];
    const failed = [];
    const guards = [...this.inflightAdds.values()].filter((guard) => guard.rootId === rootId);
    for (const guard of guards) this.cancelInflightAdd(guard, 'swarm finish');
    const unresolved = new Set(await this.failOpenReservations(rootId, 'swarm finish'));
    await Promise.all(guards.map((guard) => guard.done));
    for (const reservationId of await this.failOpenReservations(rootId, 'swarm finish')) {
      unresolved.add(reservationId);
    }
    for (const guard of guards) {
      if (guard.disposeError) {
        failed.push(
          `${guard.sessionId}: dispose unconfirmed: ${guard.disposeError instanceof Error ? guard.disposeError.message : String(guard.disposeError)}`,
        );
      }
    }
    const board = this.state.board(rootId);
    for (const member of Object.values(board?.members ?? {})) {
      if (member.role === 'coordinator' || member.status === 'killed') continue;
      try {
        const killedMember = await this.killMember(rootId, member.sessionId);
        killed.push(killedMember?.name ?? member.name);
      } catch (error) {
        this.log('warn', `finish could not kill ${member.name}`, error);
        failed.push(`${member.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const reservationId of Object.keys(this.state.board(rootId)?.reservations ?? {})) {
      unresolved.add(reservationId);
    }
    for (const reservationId of unresolved) {
      failed.push(`reservation ${reservationId}: still open`);
    }
    return { killed, failed, cancelled: guards.length };
  }

  /**
   * Finish one root: cancel and drain every in-flight add, revoke seats that
   * never committed, then kill the remaining roster. New adds for this root are
   * refused only while the drain is active; the board itself stays readable and
   * a later add succeeds. Concurrent calls share one drain.
   */
  async finish(rootId) {
    const running = this.drains.get(rootId);
    if (running) return running.promise;
    if (!this.state.board(rootId)) throw failure('NOT_MEMBER', 'no swarm board');
    const drain = {};
    // Publish the drain before runFinish starts cancelling: an abort listener
    // must not be able to slip a new add into this root mid-drain.
    this.drains.set(rootId, drain);
    drain.promise = this.runFinish(rootId).finally(() => {
      if (this.drains.get(rootId) === drain) this.drains.delete(rootId);
    });
    return drain.promise;
  }

  async sharedCwd(rootAgent, signal) {
    const wd = this.ctx.workingDirectory;
    if (!wd || typeof wd.get !== 'function') {
      throw failure('CWD_UNAVAILABLE', 'working directory service is unavailable; refusing to spawn without a shared cwd');
    }
    try {
      await wd.ensure?.(rootAgent, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw failure('CWD_UNAVAILABLE', `cannot restore the root working directory: ${error?.message ?? error}`, {
        cause: String(error?.message ?? error),
      });
    }
    let cwd;
    try {
      cwd = wd.get(rootAgent.session);
    } catch (error) {
      throw failure('CWD_UNAVAILABLE', `cannot read the root working directory: ${error?.message ?? error}`);
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw failure('CWD_UNAVAILABLE', 'root has no recorded working directory; refusing to guess one');
    }
    return cwd;
  }

  async addMember({ rootAgent, name, prompt, role = 'worker', channels, wakeMode, signal, timeoutMs = SPAWN_TIMEOUT_MS }) {
    const entry = this.ensureRoot(rootAgent);
    const rootId = entry.rootId;
    const cleanName = String(name ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(cleanName)) {
      throw failure('INVALID_NAME', 'member name must be 1-32 chars: letters, digits, . _ -');
    }
    const text = String(prompt ?? '').trim();
    if (!text) throw failure('INVALID_ARGUMENT', 'a task prompt is required');
    if (!['worker', 'monitor'].includes(role)) throw failure('INVALID_ARGUMENT', 'role must be worker or monitor');

    const sessionId = randomUUID();
    const guard = this.beginInflightAdd(rootId, sessionId);
    let activation = null;
    let reservationId = null;
    let timer = null;
    let onAbort = null;
    const clearSpawn = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (onAbort) signal?.removeEventListener?.('abort', onAbort);
      onAbort = null;
    };
    const disposeSpawn = async () => {
      if (!activation) return;
      const disposed = await this.disposeActivation(activation, { rootId, sessionId });
      if (!disposed.ok && !guard.disposeError) guard.disposeError = disposed.error;
    };
    try {
      if (guard.cancelled) throw this.cancelledAdd(guard);

      // Joining a channel is not creating it. Make the coordinator's intent
      // explicit and idempotent: channel names passed at spawn time are created
      // first, while an unknown channel still fails if creation itself fails.
      if (Array.isArray(channels) && channels.length) {
        await this.ensureChannels(rootId, channels);
      }
      if (guard.cancelled) throw this.cancelledAdd(guard);

      const reserved = await this.state.act(rootId, rootId, {
        type: 'reserveJoin',
        member: {
          sessionId,
          name: cleanName,
          role,
          ...(Array.isArray(channels) && channels.length ? { channels } : {}),
          ...(wakeMode ? { wakeMode } : {}),
        },
      });
      if (!reserved.result?.ok) {
        throw new HostError(reserved.result?.code ?? 'RESERVE_FAILED', reserved.result?.message ?? 'reserve failed');
      }
      reservationId = reserved.result.reservationId;
      if (guard.cancelled) {
        await this.failJoin(rootId, reservationId, 'cancelled before spawn');
        throw this.cancelledAdd(guard);
      }

      const controller = new AbortController();
      guard.controller = controller;
      onAbort = () => controller.abort(signal?.reason ?? new Error('swarm add aborted'));
      if (guard.cancelled || signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(new Error('swarm spawn timed out')), timeoutMs);
      timer.unref?.();

      try {
        const cwd = await this.sharedCwd(rootAgent, signal);
        if (guard.cancelled) throw this.cancelledAdd(guard);
        const promptText = this.buildChildPrompt({
          name: cleanName,
          role,
          rootName: entry.self?.name ?? 'lead',
          prompt: text,
          cwd,
        });
        activation = await this.ctx.subagents.startActivation({
          provider: 'spawn',
          delivery: 'caller',
          parent: rootAgent,
          prompt: [{ type: 'text', text: promptText }],
          signal: controller.signal,
          childId: sessionId,
          ...(cwd ? { cwd } : {}),
          ...(typeof this.ctx.subagents.resolveMaxDepth === 'function'
            ? { maxDepth: this.ctx.subagents.resolveMaxDepth() }
            : {}),
          label: `swarm:${cleanName}`,
        });
        if (!activation || activation.childId !== sessionId) {
          throw failure('SPAWN_FAILED', 'subagent returned an unexpected child id');
        }
        // Attach before any cancellation path can return: a disposed child may
        // still reject its result, and that must not become unhandled.
        if (typeof activation.result?.catch === 'function') activation.result.catch(() => {});
        if (guard.cancelled) throw this.cancelledAdd(guard);
      } catch (error) {
        clearSpawn();
        await disposeSpawn();
        await this.failJoin(
          rootId,
          reservationId,
          error instanceof Error ? error.message : String(error),
        );
        throw asHostError(error);
      }
      clearSpawn();

      // The child can finish its first turn before commitJoin lands. Observe the
      // result only after the roster row exists, and suppress rejection until then
      // so a failed commit cannot surface as an unhandled rejection.
      let committed;
      try {
        committed = await this.state.act(rootId, rootId, { type: 'commitJoin', reservationId });
      } catch (error) {
        await disposeSpawn();
        await this.failJoin(
          rootId,
          reservationId,
          `commit threw: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw asHostError(error);
      }
      if (!committed.result?.ok) {
        await disposeSpawn();
        await this.failJoin(rootId, reservationId, `commit failed: ${committed.result?.code ?? 'unknown'}`);
        throw new HostError(committed.result?.code ?? 'COMMIT_FAILED', committed.result?.message ?? 'commit failed');
      }
      if (guard.cancelled) {
        // finish accepted the add while its commit was landing. Tear the member
        // down here, before this call returns, so no worker can keep running.
        await disposeSpawn();
        await this.state.act(rootId, rootId, { type: 'kill', target: sessionId }).catch(() => {});
        throw this.cancelledAdd(guard);
      }
      if (typeof activation.result?.then === 'function') {
        this.handles.set(sessionId, activation);
        activation.result.then(
          (result) => this.onActivationEnd(rootId, sessionId, result, activation).catch((error) =>
            this.log('warn', `activation end for ${cleanName} failed`, error),
          ),
          (error) => this.onActivationEnd(rootId, sessionId, { stopReason: 'error', diagnostic: String(error) }, activation).catch(
            (failureValue) => this.log('warn', `activation rejection for ${cleanName} failed`, failureValue),
          ),
        );
      }
      return { member: committed.result.member, sessionId, handle: activation };
    } finally {
      clearSpawn();
      this.endInflightAdd(guard);
    }
  }

  buildChildPrompt({ name, role, rootName, prompt, cwd }) {
    const lines = [
      `You are "${name}", a ${role} in the Swarm led by "${rootName}".`,
      `Workspace: ${cwd ?? 'inherit the lead session working directory'} (shared with the lead; do not create worktrees unless the lead explicitly asks).`,
      '',
      'Your task:',
      truncateText(prompt, 10_000),
      '',
      'Team protocol:',
      '- Use read_board to read new posts; your first read advances your cursor.',
      '- Use post_message to report status, blockers and results to the lead. Mention people by name (for example @lead).',
      '- Use swarm_wait when you are waiting for a reply or for more work. It parks this turn; a mention will wake you.',
      '- Use the swarm tool only for coordinator actions; you are a member.',
      `- If read_board/post_message/swarm are not visible yet, the lead is finalizing your membership; continue the task and retry shortly.`,
      '- Do not spawn subagents, do not change the shared board state outside the tools, and do not ask for the lead\'s session id.',
    ];
    return truncateText(lines.join('\n'), 16_000);
  }

  async onActivationEnd(rootId, sessionId, result, activation) {
    if (activation && this.retiredActivations.has(activation)) {
      if (this.handles.get(sessionId) === activation) this.handles.delete(sessionId);
      return;
    }
    if (!activation || this.handles.get(sessionId) === activation) {
      this.handles.delete(sessionId);
    }
    if (this.disposed) return;
    const board = this.state.board(rootId);
    const member = board?.members?.[sessionId];
    if (!member || member.status === 'killed') return;
    if (member.status === 'waiting' || member.status === 'paused') return;
    const stop = result?.stopReason ?? 'error';
    const status = stop === 'completed' ? 'stopped' : 'stopped';
    const out = await this.state.act(rootId, rootId, {
      type: 'setStatus',
      status,
      target: sessionId,
    });
    if (out.result?.ok && stop !== 'completed') {
      await this.steerRoot(
        rootId,
        `[Swarm] "${member.name}" stopped with ${stop}${result?.diagnostic ? `: ${oneLine(result.diagnostic, 160)}` : ''}.`,
        'Swarm member stopped',
      ).catch(() => {});
    }
  }

  killMember(rootId, nameOrId) {
    return this.manage(rootId, nameOrId, 'kill');
  }

  pauseMember(rootId, nameOrId) {
    return this.manage(rootId, nameOrId, 'pause');
  }

  resumeMember(rootId, nameOrId) {
    return this.manage(rootId, nameOrId, 'resume');
  }

  async manage(rootId, nameOrId, type) {
    const board = this.state.board(rootId);
    if (!board) throw failure('NOT_MEMBER', 'no swarm board');
    const member =
      board.members?.[nameOrId] ??
      Object.values(board.members ?? {}).find(
        (entry) => entry.name.toLowerCase() === String(nameOrId).toLowerCase(),
      );
    if (!member) throw failure('NOT_FOUND', `member "${nameOrId}" not found`);
    if (member.role === 'coordinator' && type !== 'resume') {
      throw failure('FORBIDDEN', 'the coordinator cannot be killed or paused');
    }
    const out = await this.state.act(rootId, rootId, { type, target: member.sessionId });
    if (!out.result?.ok) throw new HostError(out.result?.code ?? 'MANAGE_FAILED', out.result?.message ?? `${type} failed`);
    if (type === 'kill' || type === 'pause') {
      const handle = this.handles.get(member.sessionId);
      let disposeFailure = null;
      if (handle) {
        this.retiredActivations.add(handle);
        const disposed = await this.disposeActivation(handle, {
          rootId,
          sessionId: member.sessionId,
        });
        if (disposed.ok) this.handles.delete(member.sessionId);
        else disposeFailure = disposed.error;
      }
      try {
        this.ctx.subagents?.interrupt?.(member.sessionId, { kind: 'ancestor', agent: this.state.rootAgent(rootId) });
      } catch {
        // A member that is not live has nothing to interrupt.
      }
      if (disposeFailure) {
        throw failure(
          'DISPOSE_FAILED',
          `member ${member.name} was stopped in the roster, but its activation could not be disposed: ${disposeFailure instanceof Error ? disposeFailure.message : String(disposeFailure)}`,
        );
      }
    } else if (type === 'resume') {
      this.quotaFailures.delete(member.sessionId);
      if (Array.isArray(out.wakes) && out.wakes.length) await this.dispatchWakes(rootId, out.wakes);
    }
    return out.result.member;
  }

  // -------------------------------------------------------------------------
  // Channels: explicit management, not an implicit side effect of `channels`
  // -------------------------------------------------------------------------

  async ensureChannels(rootId, names) {
    const board = this.state.board(rootId);
    if (!board) throw failure('NOT_MEMBER', 'no swarm board');
    const created = [];
    for (const raw of names) {
      const name = String(raw ?? '').trim();
      if (!name || name === 'main') continue;
      if (board.channels?.[name]) continue;
      const out = await this.state.act(rootId, rootId, {
        type: 'channel',
        op: 'create',
        channel: name,
      });
      if (!out.result?.ok && out.result?.code !== 'DUPLICATE_CHANNEL') {
        throw new HostError(out.result?.code ?? 'CHANNEL_FAILED', out.result?.message ?? `cannot create #${name}`);
      }
      if (out.result?.ok) created.push(name);
    }
    return created;
  }

  async createChannel(rootId, channel, topic) {
    const out = await this.state.act(rootId, rootId, {
      type: 'channel',
      op: 'create',
      channel,
      ...(topic !== undefined ? { topic } : {}),
    });
    if (!out.result?.ok) throw new HostError(out.result?.code ?? 'CHANNEL_FAILED', out.result?.message ?? 'channel create failed');
    return out.result;
  }

  async archiveChannel(rootId, channel) {
    const out = await this.state.act(rootId, rootId, { type: 'channel', op: 'archive', channel });
    if (!out.result?.ok) throw new HostError(out.result?.code ?? 'CHANNEL_FAILED', out.result?.message ?? 'channel archive failed');
    return out.result;
  }

  channelTarget(rootId, memberNameOrId) {
    const board = this.state.board(rootId);
    if (!board) throw failure('NOT_MEMBER', 'no swarm board');
    if (!memberNameOrId) return null;
    const member =
      board.members?.[memberNameOrId] ??
      Object.values(board.members ?? {}).find(
        (entry) => entry.name.toLowerCase() === String(memberNameOrId).toLowerCase(),
      );
    if (!member) throw failure('NOT_FOUND', `member "${memberNameOrId}" not found`);
    return member;
  }

  async setChannelMembership(rootId, channel, memberNameOrId, op) {
    const member = this.channelTarget(rootId, memberNameOrId);
    const out = await this.state.act(rootId, rootId, {
      type: 'channel',
      op,
      channel,
      ...(member ? { members: [member.sessionId] } : {}),
    });
    if (!out.result?.ok) {
      throw new HostError(out.result?.code ?? 'CHANNEL_FAILED', out.result?.message ?? `channel ${op} failed`);
    }
    return out.result;
  }

  subscribeChannel(rootId, channel, memberNameOrId) {
    return this.setChannelMembership(rootId, channel, memberNameOrId, 'subscribe');
  }

  unsubscribeChannel(rootId, channel, memberNameOrId) {
    return this.setChannelMembership(rootId, channel, memberNameOrId, 'unsubscribe');
  }

  async listChannels(rootId) {
    const out = await this.state.act(rootId, rootId, { type: 'channel', op: 'list' });
    if (!out.result?.ok) throw new HostError(out.result?.code ?? 'CHANNEL_FAILED', out.result?.message ?? 'channel list failed');
    return out.result.channels ?? [];
  }

  // -------------------------------------------------------------------------
  // Messages, wakes and the board API used by tools/commands
  // -------------------------------------------------------------------------

  async post(rootId, agentId, text, channel) {
    const out = await this.state.act(rootId, agentId, {
      type: 'post',
      text,
      ...(channel ? { channel } : {}),
    });
    if (out.result?.ok && out.wakes?.length) await this.dispatchWakes(rootId, out.wakes);
    return out.result;
  }

  // Remember the exact page (and rendered content) behind a tool result token.
  // Bounded so a policy that drops tools/result cannot grow memory forever.
  armReadDelivery({ token, rootId, agentId, seqs, content }) {
    if (token === undefined || token === null) return false;
    if (this.pendingReads.size >= this.pendingReadLimit) {
      const oldest = this.pendingReads.keys().next().value;
      this.pendingReads.delete(oldest);
    }
    this.pendingReads.set(token, {
      token,
      rootId,
      agentId,
      seqs: [...seqs],
      content: Array.isArray(content) ? content.map((part) => ({ ...part })) : content,
      at: nowMs(),
    });
    return true;
  }

  // tools/result is emitted synchronously and is not awaited by the runtime.
  // The commit is therefore queued here, keyed to the actor, and every later
  // read for that actor waits for the queue before selecting a new page.
  observeToolResult(exec, result) {
    const token = exec?.token;
    if (token === undefined || token === null) return false;
    const pending = this.pendingReads.get(token);
    if (!pending) return false;
    if (exec.name !== 'read_board' || exec.agent?.id !== pending.agentId) return false;
    this.pendingReads.delete(token);
    if (result?.isError !== false) return false;
    const delivered = JSON.stringify(result.content);
    const expected = JSON.stringify(pending.content);
    if (delivered !== expected) {
      this.log('warn', `read_board result for ${pending.agentId} was rewritten; cursor stays put`);
      return false;
    }
    this.queueReadCommit(pending);
    return true;
  }

  queueReadCommit(record) {
    const previous = this.readCommits.get(record.agentId) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.commitRead(record));
    this.readCommits.set(record.agentId, job);
    job.then(
      () => {
        if (this.readCommits.get(record.agentId) === job) this.readCommits.delete(record.agentId);
      },
      (error) => {
        if (this.readCommits.get(record.agentId) === job) this.readCommits.delete(record.agentId);
        this.log('warn', `could not commit delivered read for ${record.agentId}`, error);
      },
    );
    return job;
  }

  async awaitReadCommit(agentId) {
    const pending = this.readCommits.get(agentId);
    if (!pending) return;
    try {
      await pending;
    } catch {
      // The failed commit left the cursor untouched; the next read repeats the
      // same page instead of skipping it.
    }
  }

  async commitRead(record) {
    // Re-select nothing: commit exactly the page the model received. The core
    // recomputes the continuous cursor at commit time, so a missing page can
    // never be jumped over.
    const out = await this.state.act(record.rootId, record.agentId, {
      type: 'confirmRead',
      seqs: record.seqs,
    });
    if (!out.result?.ok) {
      throw failure(
        out.result?.code ?? 'INVALID_STATE',
        out.result?.message ?? 'could not commit the delivered read page',
      );
    }
    return out.result;
  }

  async read(rootId, agentId, options = {}) {
    await this.awaitReadCommit(agentId);
    return (
      await this.state.act(rootId, agentId, {
        type: 'read',
        ...(options.since !== undefined ? { since: options.since } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(Array.isArray(options.seqs) ? { seqs: options.seqs } : {}),
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.peek ? { peek: true } : {}),
        ...(options.preview ? { preview: true } : {}),
      })
    ).result;
  }

  async wait(rootId, agentId, options = {}) {
    await this.awaitReadCommit(agentId);
    const out = await this.state.act(rootId, agentId, {
      type: 'wait',
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.mentionsOnly !== undefined ? { mentionsOnly: options.mentionsOnly } : {}),
    });
    if (out.result?.ok) return out.result;
    if (out.result?.code === 'UNREAD') {
      const member = this.state.member(rootId, agentId);
      const unread = await this.read(rootId, agentId, {
        since: member?.lastReadSeq ?? 0,
        limit: 20,
        peek: true,
      });
      return {
        ...out.result,
        messages: unread?.messages ?? [],
        headSeq: unread?.headSeq ?? this.state.board(rootId)?.seq ?? 0,
        lastReadSeq: unread?.lastReadSeq ?? member?.lastReadSeq ?? 0,
      };
    }
    return out.result;
  }

  async dispatchWakes(rootId, wakes) {
    if (this.disposed) return;
    const board = this.state.board(rootId);
    if (!board) return;
    const rootAgent = this.state.rootAgent(rootId);
    if (!rootAgent) return;
    const seen = new Set();
    for (const wake of wakes ?? []) {
      if (!wake || typeof wake.sessionId !== 'string' || !Number.isInteger(wake.seq)) continue;
      const key = `${wake.sessionId}:${wake.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const member = board.members?.[wake.sessionId];
      if (!member || member.status === 'killed' || member.status === 'paused') continue;
      if (wake.seq <= member.lastReadSeq) {
        const ack = await this.ack(rootId, wake.sessionId, wake.seq, true).catch(() => null);
        if (ack?.ok) this.markReminded(wake.sessionId, wake.seq);
        continue;
      }
      const recent = this.recentWakes.get(key) ?? 0;
      if (nowMs() - recent < 1500) continue;
      this.recentWakes.set(key, nowMs());
      if (this.recentWakes.size > 512) {
        const cutoff = nowMs() - 60_000;
        for (const [stale, at] of this.recentWakes) if (at < cutoff) this.recentWakes.delete(stale);
      }
      try {
        if (wake.sessionId === rootId) {
          const message = await this.wakeMessageFor({ rootId, board, self: member, isRoot: true }, wake);
          rootAgent.steer(message);
        } else {
          const text = this.wakeText({ board, member, wake });
          await this.ctx.subagents.sendMessage(rootAgent, wake.sessionId, [{ type: 'text', text }], {
            signal: this.lifecycle.signal,
          });
        }
        const ack = await this.ack(rootId, wake.sessionId, wake.seq, true);
        if (ack?.ok) this.markReminded(wake.sessionId, wake.seq);
      } catch (error) {
        this.log('warn', `wake ${key} failed`, error);
        await this.ack(rootId, wake.sessionId, wake.seq, false, error).catch(() => {});
      }
    }
  }

  /**
   * Derive pending reminders from the committed board, not from an in-memory
   * side table. Core owns visibility (channels, controls, killed authors), and
   * targets were frozen when each post was appended.
   */
  unreadActivity(entry, { directedOnly = false } = {}) {
    if (this.disposed || !entry?.board || !entry.self) return null;
    const member = entry.self;
    if (member.status === 'killed' || member.status === 'paused') return null;
    const api = this.state.api;
    if (typeof api?.visiblePosts !== 'function') return null;
    const posts = api.visiblePosts(entry.board, member.sessionId, {
      since: member.lastReadSeq ?? 0,
    });
    const floor = Math.max(this.remindedSeq.get(member.sessionId) ?? 0, member.lastReadSeq ?? 0);
    const fresh = posts.filter((post) => Number.isInteger(post.seq) && post.seq > floor);
    if (fresh.length === 0) return null;
    const directed = fresh.filter((post) => Array.isArray(post.targets) && post.targets.includes(member.name));
    const selected = directedOnly ? directed : fresh;
    if (selected.length === 0) return null;
    return {
      latest: selected[selected.length - 1],
      fresh,
      directed: directed.length,
      headSeq: Number.isInteger(entry.board.seq) ? entry.board.seq : selected[selected.length - 1].seq,
    };
  }

  markReminded(sessionId, seq) {
    if (!Number.isInteger(seq)) return;
    const previous = this.remindedSeq.get(sessionId) ?? 0;
    if (seq > previous) this.remindedSeq.set(sessionId, seq);
  }

  async ackUnread(entry, seq) {
    const pending = this.state.pendingWake(entry.rootId, entry.self.sessionId);
    if (!pending || pending.seq > seq) return;
    await this.ack(entry.rootId, entry.self.sessionId, seq, true);
  }

  reminderText(entry, activity) {
    const { board, self } = entry;
    const directed = activity.directed > 0 ? `, ${activity.directed} directed at you` : '';
    return [
      `[Swarm] Board "${board.title}" has ${activity.fresh.length} unread post(s) (latest seq ${activity.latest.seq}, head ${activity.headSeq}${directed}).`,
      'Use read_board to read them before you park or finish.',
      'Use post_message to reply, or swarm_wait to park after reading.',
    ].join(' ');
  }

  wakeText({ board, member, wake }) {
    const pending = this.state.pendingWake(board.rootId, member.sessionId);
    const reason = pending?.reason ?? 'anything';
    if (pending && pending.seq > wake.seq) wake = { ...wake, seq: pending.seq };
    const head = board.seq ?? 0;
    const unread = Math.max(0, head - (member.lastReadSeq ?? 0));
    return [
      `[Swarm] New board activity in "${board.title}" at seq ${wake.seq} (${unread} unread, head ${head}).`,
      `You are "${member.name}" (${member.role}).`,
      reason === 'mention' ? 'You were mentioned.' : 'There is new work or a reply.',
      'Use read_board to read it, post_message to reply, or swarm_wait to park again.',
    ].join(' ');
  }

  async wakeMessageFor(entry, wake) {
    const board = entry.board;
    const text = this.wakeText({ board, member: entry.self, wake });
    return this.makeMessage(text, `Swarm wake in "${board.title}" (seq ${wake.seq})`);
  }

  async steerRoot(rootId, text, summary) {
    const root = this.state.rootAgent(rootId);
    if (!root) return false;
    const message = await this.makeMessage(text, summary);
    root.steer(message);
    return true;
  }

  async ack(rootId, sessionId, seq, delivered, error = undefined) {
    try {
      const out = await this.state.act(rootId, rootId, {
        type: 'wakeResult',
        sessionId,
        seq,
        delivered: delivered !== false,
        ...(error ? { error: oneLine(error instanceof Error ? error.message : String(error), 160) } : {}),
      });
      if (out.result?.ok === false && out.result.code !== 'NOT_FOUND') {
        this.log('warn', `wake ack ${sessionId}:${seq} rejected: ${out.result.code}`);
      }
      return out.result;
    } catch (errorValue) {
      this.log('warn', `wake ack ${sessionId}:${seq} failed`, errorValue);
      return { ok: false, code: 'ACK_FAILED' };
    }
  }

  view(rootId, options) {
    const board = this.state.board(rootId);
    if (!board) return null;
    return buildPublicView(board, {
      ...options,
      visiblePosts: this.state.api.visiblePosts,
    });
  }

  // -------------------------------------------------------------------------
  // Inspection guard: expire reservations whose spawn never committed.
  // -------------------------------------------------------------------------

  async cleanupReservations() {
    if (this.disposed) return;
    const live = new Set((this.ctx.agents?.list?.() ?? []).map((agent) => agent.id));
    for (const rootId of this.state.roots()) {
      const board = this.state.board(rootId);
      if (!board) continue;
      if (!this.state.rootAgent(rootId)) continue;
      for (const [reservationId, reservation] of Object.entries(board.reservations ?? {})) {
        if (this.handles.has(reservation.sessionId)) continue;
        if (live.has(reservation.sessionId)) continue;
        const age = nowMs() - Number(reservation.at ?? reservation.reservedAt ?? 0);
        if (!Number.isFinite(age) || age < RESERVATION_TTL_MS) continue;
        try {
          await this.state.act(rootId, rootId, {
            type: 'failJoin',
            reservationId,
            reason: 'reservation timed out before spawn committed',
          });
        } catch (error) {
          this.log('warn', `expire reservation ${reservationId} failed`, error);
        }
      }
    }
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Structurally identical to dsh-llm's `createUserMessage` result: a frozen
 * `{id, role:'user', content, source}` value with a fresh MessageId. Keeping the
 * factory local avoids an undeclared host-package dependency; `source.kind` is a
 * merge-extensible producer tag and the `notice` form matches the reviewed
 * `ContextForm` contract (summary <= 120 chars).
 */
export function createSwarmMessage(text, summary) {
  const account = String(summary ?? 'Swarm notice');
  const bounded = account.length <= 120 ? account : `${account.slice(0, 119)}…`;
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }],
    source: { kind: 'swarm', form: 'notice', summary: bounded },
  });
}

export const defaultMakeMessage = async (text, summary) => createSwarmMessage(text, summary);

export { byteLength };
