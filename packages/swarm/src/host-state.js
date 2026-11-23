import { HostError, failure, isPlainObject } from './host-format.js';

const KEY_PREFIX = 'swarm_';
const SAFE_ROOT = /^[A-Za-z0-9_-]{1,120}$/;

// Per-record storage turns a key into a path segment and only accepts
// `[A-Za-z0-9_-]`. Root session ids are normally UUIDs, but never assume it.
function encodeRootId(rootId) {
  const raw = String(rootId ?? '');
  if (SAFE_ROOT.test(raw)) return `s_${raw}`;
  return `x_${Buffer.from(raw, 'utf8').toString('base64url')}`;
}

export function boardKey(rootId) {
  return `${KEY_PREFIX}${encodeRootId(rootId)}`;
}

function blankIndex(store) {
  return {
    store,
    boards: new Map(),
    memberRoots: new Map(),
    loaded: false,
  };
}

/**
 * Owns durable per-root boards and the root/member indexes. Every mutation goes
 * through the core's pure `transition` inside `store.transact`.
 */
export class BoardState {
  constructor({ ctx, store, board, channels, logger }) {
    this.ctx = ctx;
    this.store = store;
    this.api = board;
    this.channels = channels;
    this.logger = logger;
    Object.assign(this, blankIndex(store));
  }

  async load() {
    if (this.loaded) return;
    const entries = await this.store.entries();
    for (const [key, value] of entries) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      if (!isPlainObject(value) || value.version !== 1 || typeof value.rootId !== 'string') continue;
      if (key !== boardKey(value.rootId)) continue;
      this.remember(value);
    }
    this.loaded = true;
  }

  remember(board) {
    if (!board || typeof board.rootId !== 'string') return;
    const cached = this.boards.get(board.rootId);
    if (cached && cached !== board) {
      const incomingAt = Number(board.updatedAt ?? 0);
      const cachedAt = Number(cached.updatedAt ?? 0);
      if (incomingAt < cachedAt) return;
      if (incomingAt === cachedAt && Number(board.seq ?? 0) < Number(cached.seq ?? 0)) return;
    }
    this.boards.set(board.rootId, board);
    for (const member of Object.values(board.members ?? {})) {
      if (member && typeof member.sessionId === 'string') {
        this.memberRoots.set(member.sessionId, board.rootId);
      }
    }
  }

  forget(rootId) {
    const board = this.boards.get(rootId);
    if (!board) return;
    for (const member of Object.values(board.members ?? {})) {
      if (this.memberRoots.get(member?.sessionId) === rootId) {
        this.memberRoots.delete(member.sessionId);
      }
    }
    this.boards.delete(rootId);
  }

  board(rootId) {
    return this.boards.get(rootId) ?? null;
  }

  roots() {
    return [...this.boards.keys()];
  }

  member(rootId, sessionId) {
    const board = this.boards.get(rootId);
    if (!board) return null;
    return board.members?.[sessionId] ?? null;
  }

  memberByName(rootId, name) {
    const board = this.boards.get(rootId);
    if (!board) return null;
    const wanted = String(name ?? '').toLowerCase();
    for (const member of Object.values(board.members ?? {})) {
      if (member.name.toLowerCase() === wanted) return member;
    }
    return null;
  }

  rootAgent(rootId) {
    return this.ctx.agents?.get?.(rootId) ?? null;
  }

  /**
   * Resolve an agent to its Swarm. A member belongs to its root's board; a root
   * owns its own board. Falls back to the live collaboration root so a freshly
   * restored member still resolves before its first wake.
   */
  resolve(agent) {
    if (!agent || typeof agent.id !== 'string') return null;
    let rootId = this.memberRoots.get(agent.id) ?? null;
    if (!rootId && this.boards.has(agent.id)) rootId = agent.id;
    if (!rootId) {
      try {
        const root = this.ctx.subagents?.rootOf?.(agent);
        if (root && this.boards.has(root.id)) rootId = root.id;
      } catch {
        // Not in a collaboration tree (or not live): no Swarm.
      }
    }
    if (!rootId) return null;
    const board = this.boards.get(rootId);
    if (!board) return null;
    const self = board.members?.[agent.id] ?? null;
    return {
      rootId,
      board,
      self,
      isRoot: board.rootId === agent.id,
      role: self?.role ?? null,
      status: self?.status ?? null,
    };
  }

  async create(rootAgent, title = 'Swarm', name = 'lead') {
    if (!rootAgent || typeof rootAgent.id !== 'string') {
      throw failure('INVALID_SESSION', 'a live root session is required');
    }
    const existing = this.resolve(rootAgent);
    if (existing) {
      throw failure('EXISTS', `this session already belongs to swarm "${existing.board.title}"`);
    }
    if (this.ctx.subagents?.rootOf) {
      let root = null;
      try {
        root = this.ctx.subagents.rootOf(rootAgent);
      } catch {
        root = null;
      }
      if (root && root !== rootAgent) {
        throw failure('FORBIDDEN', 'only the root (lead) session can create a swarm');
      }
    }
    const key = boardKey(rootAgent.id);
    const cleanTitle = String(title ?? '').trim() || 'Swarm';
    const cleanName = String(name ?? '').trim() || 'lead';
    const outcome = await this.store.transact(key, (current) => {
      if (current) return { state: current, result: { created: false, board: current } };
      let board;
      try {
        board = this.api.newBoard(rootAgent.id, cleanTitle, {
          coordinator: { sessionId: rootAgent.id, name: cleanName },
          now: Date.now(),
        });
      } catch (error) {
        throw new HostError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
      }
      return { state: board, result: { created: true, board } };
    });
    const board = outcome.board;
    this.remember(board);
    if (!outcome.created) {
      throw failure('EXISTS', `this session already belongs to swarm "${board.title}"`);
    }
    return board;
  }

  /**
   * Apply one core transition through the durable store. The per-key promise
   * tail serializes transitions, so two tools in one step cannot fork the board
   * or publish an older state over a newer cache entry.
   */
  async act(rootId, actorSessionId, action) {
    const key = boardKey(rootId);
    const cached = this.boards.get(rootId);
    if (!cached) throw failure('NOT_MEMBER', 'no swarm board for this session');
    if (!isPlainObject(action) || typeof action.type !== 'string') {
      throw failure('INVALID_ACTION', 'invalid swarm action');
    }
    const input = action.now === undefined ? { ...action, now: Date.now() } : action;
    let outcome;
    try {
      outcome = await this.store.transact(key, (current) => {
        const board = current ?? this.boards.get(rootId);
        if (!board) throw failure('NOT_MEMBER', 'no swarm board for this session');
        let transitioned;
        try {
          transitioned = this.api.transition(board, actorSessionId, input);
        } catch (error) {
          throw new HostError(
            'INVALID_ACTION',
            error instanceof Error ? error.message : String(error),
          );
        }
        if (!transitioned?.result?.ok) {
          return {
            state: board,
            result: { result: transitioned.result, wakes: transitioned.wakes ?? [] },
          };
        }
        return {
          state: transitioned.state,
          result: { result: transitioned.result, wakes: transitioned.wakes ?? [] },
        };
      });
    } catch (error) {
      throw asHostError(error);
    }
    // Read back the committed record. `remember` is monotonic, so a slower
    // outcome can never overwrite a newer board already in memory.
    const persisted = this.store.get(key) ?? outcome.state;
    const transitionResult = outcome?.result;
    const wakes = outcome?.wakes ?? [];
    if (transitionResult?.ok && persisted) this.remember(persisted);
    return {
      state: persisted,
      result: transitionResult,
      wakes,
    };
  }

  view(rootId, options = {}) {
    const board = this.boards.get(rootId);
    if (!board) return null;
    return this.api.boardView(board, options);
  }

  memberNames(rootId) {
    const board = this.boards.get(rootId);
    if (!board) return [];
    return Object.values(board.members ?? {})
      .filter((member) => member.status !== 'killed')
      .map((member) => member.name);
  }

  pendingWake(rootId, sessionId) {
    const board = this.boards.get(rootId);
    return board?.pendingWakes?.find((wake) => wake.sessionId === sessionId) ?? null;
  }
}
