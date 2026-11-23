// Teamwork v1 persistent campaign state machine.
//
// Pure JSON in, pure JSON out.  Time is supplied by the caller; the only side
// effect is the optional local store used by createCampaign/loadCampaign.

import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { formatFrozenSpec } from './frozen-spec.js';
import {
  INTERVIEW_STEPS,
  REQUIRED_INTERVIEW_KEYS,
  buildInterviewDraft,
  interviewStepIndex,
  mapIntegrityRestrictions,
} from './interview.js';

export const STATUSES = Object.freeze([
  'draft',
  'awaiting-confirm',
  'running',
  'paused',
  'verifying',
  'done',
  'failed',
  'cancelled',
]);

export const TERMINAL_STATUSES = Object.freeze(['done', 'failed', 'cancelled']);
export const ACTIVE_STATUSES = Object.freeze(['running', 'verifying', 'paused']);
export const MODES = Object.freeze(['swe-light', 'general']);
export const ROLE_PRESETS = Object.freeze({
  implementer: 'dk-teamwork-implementer',
  explorer: 'dk-teamwork-explorer',
  'spec-miner': 'dk-teamwork-explorer',
  'e2e-orchestrator': 'dk-teamwork-explorer',
  reviewer: 'dk-teamwork-reviewer',
  challenger: 'dk-teamwork-reviewer',
  'forensic-auditor': 'dk-teamwork-reviewer',
  'victory-auditor': 'dk-teamwork-auditor',
});
export const ISSUE_SEVERITIES = Object.freeze([
  'low', 'medium', 'high', 'critical', 'blocker', 'integrity',
]);
export const ISSUE_PROTOCOL = 'ISSUE|severity|summary|evidence';
export const ROLES_WITH_ISSUE_PROTOCOL = Object.freeze([
  'reviewer', 'challenger', 'forensic-auditor', 'victory-auditor',
]);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DEFAULT_POLICY = Object.freeze({
  ttlMs: 12 * HOUR,
  stallMs: 30 * MINUTE,
  leaseMs: 5 * MINUTE,
  maxRounds: 32,
  maxDispatches: 40,
  successionThreshold: 16,
});

const SUMMARY_LIMIT = 1000;
const EVIDENCE_LIMIT = 500;
const EVIDENCE_JSON_LIMIT = 4096;
const PROMPT_LIMIT = 8192;
const TRACE_LIMIT = 100;
const OPEN_LEDGER_LIMIT = 80;
const CLOSED_LEDGER_LIMIT = 50;
const VERDICT_LIMIT = 32;
const EVIDENCE_HISTORY_LIMIT = 10;
const TASK_LIMIT = 128;

function nowOf(value) {
  return Number.isFinite(value) ? value : Date.now();
}

function textOf(value, limit = PROMPT_LIMIT) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\u0000/g, '').trim().slice(0, limit);
}

// Bounded display text that keeps both ends, so the changing suffix of a long
// failure reason remains visible in round history and retry briefs.
function middleText(value, limit) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (text.length <= limit) return text;
  const head = Math.max(0, Math.floor(limit / 2) - 20);
  const tail = Math.max(0, limit - head - 40);
  return `${text.slice(0, head)}…[omitted ${text.length - head - tail} characters]…${text.slice(-tail)}`;
}

// Identity for repeated-failure detection is derived from the full cause. It
// must never be derived from display-clipped text, where two different reasons
// can share an identical prefix.
function reasonDigest(value) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  return text ? createHash('sha256').update(text).digest('hex') : null;
}

function normalizeDirectory(value, base) {
  const raw = textOf(value, 4096);
  if (!raw) return '';
  const resolved = resolvePath(base || process.cwd(), raw);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function workdirMatches(cwd, value) {
  const base = textOf(cwd, 4096) || process.cwd();
  const requested = textOf(value, 4096);
  if (!requested) return false;
  return normalizeDirectory(requested, base) === normalizeDirectory(base, base);
}

function workdirMismatchReason(cwd, value) {
  const base = textOf(cwd, 4096) || process.cwd();
  const requested = textOf(value, 4096) || '(empty)';
  return `workdir ${requested} resolves outside campaign workspace ${base}. The workdir is fixed when the run is created; create a new run with @cwd ${requested} instead.`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRunId() {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `tw-${stamp}-${random}`;
}

function makeLeaseToken(ownerId, at) {
  const hash = createHash('sha256')
    .update(`${ownerId}|${at}|${Math.random()}`)
    .digest('hex');
  return `twl_${hash.slice(0, 24)}`;
}

function hashToken(prefix, value) {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

function fail(code, reason) {
  return { ok: false, code, reason: reason || code };
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

function serializeSafe(value) {
  // The store only accepts real JSON.  This helper is intentionally used at the
  // boundary of every produced state so optional fields never leak undefined.
  return JSON.parse(JSON.stringify(value));
}

function emptySpec(cwd, confirmedCommand) {
  return {
    frozen: false,
    version: 0,
    token: null,
    text: '',
    originalRequest: '',
    confirmedCommand: confirmedCommand || '',
    integrity: {
      mode: 'development',
      selected: [],
      notAllowed: [],
      standardLibraryOnly: false,
    },
    constraints: [],
    deliverables: [],
    acceptance: '',
    workdir: cwd,
    files: [],
    routeSignals: {},
  };
}

/**
 * Acceptance evidence files are relative paths owned by the campaign.  Host
 * input may contain junk, so normalize and bound it here once.
 */
function normalizeFiles(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[\n,]/) : []);
  const files = [];
  for (const entry of raw) {
    const file = textOf(entry, 1024).replace(/\\/g, '/');
    if (!file) continue;
    if (file.startsWith('/') || file.startsWith('~') || /^[a-zA-Z]:\//.test(file)) continue;
    if (file.split('/').some(seg => seg === '..')) continue;
    if (!files.includes(file)) files.push(file);
    if (files.length >= 4) break;
  }
  return files;
}

function emptyPlan(route, policy) {
  return {
    version: 1,
    token: null,
    route,
    tasks: [],
    audit: auditMeta(),
    budget: { maxRounds: policy.maxRounds, maxDispatches: policy.maxDispatches },
  };
}

function auditMeta() {
  return {
    role: 'victory-auditor',
    preset: ROLE_PRESETS['victory-auditor'],
    independent: true,
    freshContext: true,
    maxAttempts: 2,
    phases: ['a', 'b', 'c'],
  };
}

function makeBudget(role, route) {
  const base = role === 'implementer'
    ? { timeoutMs: 30 * MINUTE, maxTurns: 12, maxDispatches: 40 }
    : { timeoutMs: 10 * MINUTE, maxTurns: 8, maxDispatches: 40 };
  return {
    ...base,
    maxAttempts: role === 'implementer' && route === 'general' ? 2 : 1,
  };
}

function traceEntry(seq, at, type, status, summary) {
  return {
    seq,
    at,
    type: textOf(type, 64),
    status: textOf(status, 32),
    summary: textOf(summary, 300),
  };
}

function pushTrace(state, at, type, summary, status = state.status) {
  state.traceSeq += 1;
  state.trace.push(traceEntry(state.traceSeq, at, type, status, summary));
  if (state.trace.length > TRACE_LIMIT) {
    state.trace.splice(0, state.trace.length - TRACE_LIMIT);
  }
}

function bump(state, at) {
  state.revision += 1;
  state.updatedAt = at;
}

function recordProgress(state, at) {
  state.lastProgressAt = at;
  state.rounds.lastProgressAt = at;
}

function specPrompt(state) {
  return formatFrozenSpec(state.spec, {
    cwd: state.cwd,
    route: state.spec.routeSignals.route || state.route,
    heading: false,
  });
}

function implementerPrompt(state) {
  return [
    'Role: implementer',
    'Implement the frozen spec inside the declared write scope.',
    'Do not change the frozen acceptance criteria. Do not claim verification you did not run.',
    specPrompt(state),
    'Report the files changed, checks actually performed, and remaining limitations. An independent reviewer supplies the verdict.',
  ].join('\n');
}

function reviewPrompt(state, role) {
  return [
    `Role: ${role}`,
    'Independently verify the implementation against the frozen spec. Read-only: write scope is empty.',
    'Check the host-provided acceptance receipt against the code. Do not run the acceptance command or trust the implementer report.',
    specPrompt(state),
    'Report: VERDICT|pass|fail|veto|reason',
    `Report each problem as: ${ISSUE_PROTOCOL}`,
    'If a previous issue is fixed, the host closes it with evidence before the role result.',
  ].join('\n');
}

function surveyPrompt(state, role, focus) {
  return [
    `Role: ${role}`,
    `Survey focus: ${focus}`,
    'Read-only reconnaissance. Do not modify source files.',
    specPrompt(state),
    'Return findings as evidence and open questions; report problems as ISSUE|severity|summary|evidence.',
  ].join('\n');
}

function e2ePrompt(state) {
  return [
    'Role: e2e-orchestrator',
    'Read-only: inspect the existing end-to-end track, note coverage gaps and recommend minimal cases to the writer. Do not build or run tests.',
    specPrompt(state),
    'Return survey findings, paths and open risks.',
  ].join('\n');
}

function taskRecord({
  id, role, preset, phase, deps = [], writeScope = [], prompt,
  status = deps.length ? 'pending' : 'dispatched', gate = true, route,
}) {
  return {
    id,
    role,
    preset: preset || ROLE_PRESETS[role] || ROLE_PRESETS.reviewer,
    phase,
    deps: [...deps],
    writeScope: [...writeScope],
    budget: makeBudget(role, route),
    status,
    prompt: textOf(prompt, PROMPT_LIMIT),
    promptIsComplete: false,
    issueProtocol: ROLES_WITH_ISSUE_PROTOCOL.includes(role) ? ISSUE_PROTOCOL : null,
    gate,
    childSessionId: null,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    outcome: null,
    failureReason: null,
    failureIdentity: null,
  };
}

function makePlan(state, round) {
  const route = state.route;
  const policy = state.policy;
  const previous = state.plan && Array.isArray(state.plan.tasks) ? state.plan.tasks : [];
  const version = Number.isInteger(state.plan?.version) ? state.plan.version + (state.plan.tasks.length ? 1 : 0) : 1;
  const tasks = [];

  if (route === 'swe-light') {
    const implId = `impl-r${round}`;
    const reviewId = `review-r${round}`;
    tasks.push(taskRecord({
      id: implId, role: 'implementer', preset: ROLE_PRESETS.implementer,
      phase: 'implement', deps: [], writeScope: ['workspace'],
      prompt: implementerPrompt(state), route,
    }));
    tasks.push(taskRecord({
      id: reviewId, role: 'reviewer', preset: ROLE_PRESETS.reviewer,
      phase: 'verify', deps: [implId], writeScope: [],
      prompt: reviewPrompt(state, 'reviewer'), route,
    }));
  } else {
    const survey = previous.filter(t => t.phase === 'survey' || t.phase === 'e2e');
    if (survey.length && round > 1) {
      tasks.push(...clone(survey));
    } else {
      for (let i = 1; i <= 3; i++) {
        tasks.push(taskRecord({
          id: `explore-${i}`, role: 'explorer', preset: ROLE_PRESETS.explorer,
          phase: 'survey', deps: [], writeScope: [],
          prompt: surveyPrompt(state, 'explorer', `repository area ${i}`), route,
        }));
      }
      tasks.push(taskRecord({
        id: 'spec-miner', role: 'spec-miner', preset: ROLE_PRESETS.explorer,
        phase: 'survey', deps: ['explore-1', 'explore-2', 'explore-3'], writeScope: [],
        prompt: surveyPrompt(state, 'spec-miner', 'extract constraints and acceptance obligations'), route,
      }));
      tasks.push(taskRecord({
        id: 'e2e-1', role: 'e2e-orchestrator', preset: ROLE_PRESETS.explorer,
        phase: 'e2e', deps: ['explore-1', 'explore-2', 'explore-3'], writeScope: ['e2e'],
        prompt: e2ePrompt(state), route,
      }));
    }
    const surveyIds = tasks.filter(t => t.phase === 'survey' || t.phase === 'e2e').map(t => t.id);
    const implId = `impl-r${round}`;
    tasks.push(taskRecord({
      id: implId, role: 'implementer', preset: ROLE_PRESETS.implementer,
      phase: 'implement', deps: surveyIds, writeScope: ['workspace'],
      prompt: implementerPrompt(state), route,
    }));

    const verifiers = [
      { id: `review-1-r${round}`, role: 'reviewer' },
      { id: `review-2-r${round}`, role: 'reviewer' },
      { id: `challenger-1-r${round}`, role: 'challenger' },
      { id: `challenger-2-r${round}`, role: 'challenger' },
      { id: `forensic-r${round}`, role: 'forensic-auditor' },
    ];
    for (const v of verifiers) {
      tasks.push(taskRecord({
        id: v.id, role: v.role, preset: ROLE_PRESETS[v.role] || ROLE_PRESETS.reviewer,
        phase: 'verify', deps: [implId], writeScope: [],
        prompt: reviewPrompt(state, v.role), route,
      }));
    }
  }

  const limited = tasks.slice(0, TASK_LIMIT);
  const plan = {
    version,
    token: hashToken('plan', { route, version, tasks: limited.map(t => t.id) }),
    route,
    tasks: limited,
    audit: auditMeta(),
    budget: { maxRounds: policy.maxRounds, maxDispatches: policy.maxDispatches },
  };
  return plan;
}

function dispatchReady(state) {
  const effects = [];
  let changed = false;
  for (const task of state.plan.tasks) {
    if (task.status !== 'pending') continue;
    const depsMet = task.deps.every(id => {
      const dep = state.plan.tasks.find(t => t.id === id);
      return dep && dep.status === 'pass';
    });
    if (depsMet) {
      task.status = 'dispatched';
      effects.push(`dispatch:${task.id}`);
      changed = true;
    }
  }
  return { effects, changed };
}

function initialDispatchEffects(state) {
  return state.plan.tasks
    .filter(t => t.status === 'dispatched')
    .map(t => `dispatch:${t.id}`);
}

function issueSummary(issue) {
  return textOf(issue?.summary, SUMMARY_LIMIT);
}

function issueEvidence(issue) {
  return textOf(issue?.evidence, EVIDENCE_LIMIT);
}

/**
 * A child may return arbitrary evidence.  Keep the state bounded without
 * losing the fact that the payload was truncated.
 */
function boundEvidence(value) {
  if (value === null || value === undefined) return null;
  const safe = serializeSafe(value);
  let json;
  try {
    json = JSON.stringify(safe);
  } catch {
    return { truncated: true, preview: '[unserializable evidence]' };
  }
  if (json.length <= EVIDENCE_JSON_LIMIT) return safe;
  return {
    truncated: true,
    preview: json.slice(0, EVIDENCE_JSON_LIMIT - 64),
  };
}

function normalizeSeverity(value) {
  const text = textOf(value, 32).toLowerCase();
  return ISSUE_SEVERITIES.includes(text) ? text : 'medium';
}

function gateVerdict(task, at) {
  return {
    taskId: task.id,
    role: task.role,
    outcome: task.status,
    reason: textOf(task.failureReason, 512),
    at,
  };
}

function failCampaign(state, at, code, reason, effects = []) {
  state.status = 'failed';
  state.failure = {
    code,
    reason: textOf(reason, 1024),
    at,
    requiresManualResume: true,
    writesAllowed: false,
  };
  pushTrace(state, at, 'failure', `${code}: ${reason}`);
  return [...effects, 'stop'];
}

function pauseCampaign(state, at, code, reason, effects = []) {
  state.status = 'paused';
  state.failure = {
    code,
    reason: textOf(reason, 1024),
    at,
    requiresManualResume: true,
    writesAllowed: false,
  };
  pushTrace(state, at, 'paused', `${code}: ${reason}`);
  return [...effects, 'pause'];
}

function integrityFailure(state, at, reason) {
  state.gate.integrityViolation = true;
  state.gate.decision = 'fail';
  return failCampaign(state, at, 'INTEGRITY_VETO', reason, []);
}

function failedTasks(state) {
  return state.plan.tasks.filter(t => t.status !== 'pass');
}

function startNextRound(state, at, failureTasks, source = 'gate') {
  if (state.rounds.current >= state.rounds.max) {
    return {
      effects: failCampaign(
        state, at, 'MAX_ROUNDS',
        `round ${state.rounds.current}/${state.rounds.max} exhausted`,
      ),
    };
  }

  const signature = source === 'audit'
    ? 'audit-failure'
    : source === 'issues'
      ? `issues:${state.ledger.open.map(i => i.id).sort().join(',')}`
      : JSON.stringify(failureTasks
        .map(t => `${t.role}:${t.outcome || 'fail'}:${t.failureIdentity || t.failureReason || ''}`)
        .sort());
  if (source === 'issues') {
    // An unresolved issue is a deliberate retry, not an oscillation.  It still
    // consumes a round and is stopped by the hard round cap.
    state.rounds.signature = null;
    state.rounds.consecutiveFailures = 0;
  } else {
    if (signature === state.rounds.signature) {
      state.rounds.consecutiveFailures += 1;
    } else {
      state.rounds.signature = signature;
      state.rounds.consecutiveFailures = 1;
    }
    if (state.rounds.consecutiveFailures >= 2) {
      return {
        effects: pauseCampaign(
          state, at, 'OSCILLATION',
          'same failure signature repeated; automatic retry would loop',
        ),
      };
    }
  }

  const failedRound = state.rounds.current;
  state.rounds.history.push({
    round: failedRound,
    at,
    signature,
    failed: failureTasks.map(t => ({ id: t.id, role: t.role, reason: middleText(t.failureReason, 512) })),
    openIssues: state.ledger.open.length,
  });
  if (state.rounds.history.length > state.rounds.max) {
    state.rounds.history.splice(0, state.rounds.history.length - state.rounds.max);
  }

  state.rounds.current += 1;
  state.status = 'running';
  state.plan = makePlan(state, state.rounds.current);
  state.gate = {
    decision: 'retry',
    integrityViolation: false,
    required: state.plan.tasks.map(t => t.id),
    verdicts: state.gate.verdicts.slice(-VERDICT_LIMIT),
    openIssueIds: state.ledger.open.map(i => i.id),
    lastEvaluatedAt: at,
  };
  state.audit = {
    status: 'idle',
    independent: null,
    freshContext: null,
    auditorSessionId: null,
    phases: null,
    attempts: state.audit.attempts,
    maxAttempts: state.plan.audit.maxAttempts,
    reason: state.audit.reason,
    verdict: state.audit.verdict,
    verifiedCommand: null,
    evidence: null,
  };
  recordProgress(state, at);
  pushTrace(state, at, 'round', `retry round ${state.rounds.current}/${state.rounds.max}`);
  return { effects: ['retry-round', ...initialDispatchEffects(state)] };
}

function evaluateGate(state, at) {
  const dispatched = dispatchReady(state);
  const tasks = state.plan.tasks;
  const failed = tasks.filter(t => t.status === 'fail');
  const allTerminal = tasks.length > 0 && tasks.every(t => ['pass', 'fail'].includes(t.status));
  const allPass = allTerminal && failed.length === 0;
  const open = state.ledger.open.length;

  state.gate.required = tasks.map(t => t.id);
  state.gate.openIssueIds = state.ledger.open.map(i => i.id);
  state.gate.lastEvaluatedAt = at;
  for (const task of tasks) {
    if (task.status === 'pass' || task.status === 'fail') {
      state.gate.verdicts.push(gateVerdict(task, at));
    }
  }
  if (state.gate.verdicts.length > VERDICT_LIMIT) {
    state.gate.verdicts.splice(0, state.gate.verdicts.length - VERDICT_LIMIT);
  }

  if (state.gate.integrityViolation) {
    state.gate.decision = 'fail';
    return { effects: [...dispatched.effects, ...failCampaign(state, at, 'INTEGRITY_VETO', 'integrity veto recorded')] };
  }

  // Any crashed role pauses the campaign. Only explicit verdict failures may
  // drive a new round; a process failure must never auto-dispatch a worker.
  const errored = failed.find(t => t.outcome === 'error');
  if (errored) {
    state.gate.decision = 'retry';
    return {
      effects: [...dispatched.effects, ...pauseCampaign(
        state, at, 'ROLE_FAILED',
        `${errored.role} ${errored.id} errored: ${errored.failureReason || 'no reason'}`,
      )],
    };
  }

  // Survey/E2E tasks are prerequisites for implementation. If one fails while
  // its dependents are still pending, a normal all-terminal retry would deadlock
  // (the pending dependents can never start). Pause for explicit recovery.
  const surveyFailure = failed.find(t => t.phase === 'survey' || t.phase === 'e2e');
  if (surveyFailure) {
    state.gate.decision = 'retry';
    return {
      effects: [...dispatched.effects, ...pauseCampaign(
        state, at, 'SURVEY_FAILED',
        `${surveyFailure.role} ${surveyFailure.id} failed: ${surveyFailure.failureReason || 'no reason'}`,
      )],
    };
  }

  // A writing worker failure always pauses. It must never be silently retried
  // by the state machine, even while the reviewer task is still pending.
  const writingFailure = failed.find(t => t.role === 'implementer');
  if (writingFailure) {
    state.gate.decision = 'retry';
    return {
      effects: [...dispatched.effects, ...pauseCampaign(
        state, at, 'ROLE_FAILED',
        `implementer ${writingFailure.id} failed: ${writingFailure.failureReason || 'no reason'}`,
      )],
    };
  }

  if (allPass && open === 0) {
    state.gate.decision = 'pass';
    state.status = 'verifying';
    state.audit.status = 'pending';
    state.audit.independent = true;
    state.audit.freshContext = true;
    state.audit.auditorSessionId = null;
    state.audit.phases = null;
    state.audit.verifiedCommand = null;
    state.audit.evidence = null;
    recordProgress(state, at);
    pushTrace(state, at, 'gate', 'strict AND gate passed; independent audit requested');
    return { effects: [...dispatched.effects, 'request-audit'] };
  }

  state.gate.decision = 'retry';
  if (allTerminal) {
    return startNextRound(state, at, failed, failed.length === 0 ? 'issues' : 'gate');
  }
  return { effects: dispatched.effects };
}

function applyConfirmation(state, event, at) {
  if (isTerminalStatus(state.status)) return { result: fail('TERMINAL', 'campaign is terminal') };
  if (state.spec.frozen) return { result: fail('ALREADY_CONFIRMED', 'spec is already frozen') };
  if (state.status !== 'awaiting-confirm' || !state.interview.draft) {
    return { result: fail('CONFIRM_REQUIRED', 'draft is not awaiting confirmation') };
  }
  if (event.source !== 'manual-chat') {
    return { result: fail('NOT_MANUAL', 'confirmation must come from a manual chat message') };
  }
  const draft = state.interview.draft;
  if (typeof event.text !== 'string' || event.text !== draft.confirmLine) {
    return { result: fail('TEXT_MISMATCH', `expected exact text: ${draft.confirmLine}`) };
  }
  if (Number(event.version) !== Number(draft.version)) {
    return { result: fail('STALE_VERSION', 'draft version is no longer current') };
  }
  if (String(event.token ?? '') !== draft.token) {
    return { result: fail('STALE_TOKEN', 'draft token is no longer current') };
  }
  if (event.command && textOf(event.command, 4096) !== textOf(draft.confirmedCommand, 4096)) {
    return { result: fail('COMMAND_MISMATCH', 'confirmation command does not match the frozen draft') };
  }
  if (!workdirMatches(state.cwd, draft.workdir)) {
    return { result: fail('WORKDIR_MISMATCH', workdirMismatchReason(state.cwd, draft.workdir)) };
  }

  const answers = draft.answers || {};
  state.route = draft.route;
  state.mode = draft.mode || state.mode;
  state.spec = {
    frozen: true,
    version: draft.version,
    token: draft.token,
    text: draft.text,
    originalRequest: textOf(state.originalRequest, 16384) || draft.text,
    confirmedCommand: draft.confirmedCommand,
    integrity: {
      mode: draft.integrity.mode,
      selected: [...draft.integrity.selected],
      notAllowed: [...draft.integrity.notAllowed],
      standardLibraryOnly: !!draft.integrity.standardLibraryOnly,
    },
    constraints: [...draft.constraints],
    deliverables: [...draft.deliverables],
    acceptance: draft.acceptance,
    workdir: state.cwd,
    files: [...(draft.files || state.spec.files || [])],
    routeSignals: {
      route: draft.route,
      integrityMode: draft.integrity.mode,
      restrictions: [...draft.integrity.selected],
    },
  };
  state.interview.step = 9;
  state.interview.confirmation = {
    text: event.text,
    token: draft.token,
    version: draft.version,
    source: 'manual-chat',
    at,
  };
  state.status = 'running';
  state.expiresAt = at + state.policy.ttlMs;
  state.rounds.current = 1;
  state.rounds.signature = null;
  state.rounds.consecutiveFailures = 0;
  state.plan = makePlan(state, 1);
  state.stats.rounds = 1;
  recordProgress(state, at);
  pushTrace(state, at, 'confirmed', `spec frozen v${draft.version}; route ${draft.route}`);

  return {
    result: ok({ runId: state.runId, planVersion: state.plan.version }),
    effects: initialDispatchEffects(state),
  };
}

function applyInterviewAnswer(state, event, at) {
  if (isTerminalStatus(state.status)) return { result: fail('TERMINAL', 'campaign is terminal') };
  if (state.spec.frozen) return { result: fail('FROZEN_SPEC', 'spec is frozen') };
  if (!['draft', 'awaiting-confirm'].includes(state.status)) {
    return { result: fail('INVALID_STATE', 'interview answers are only accepted before confirmation') };
  }

  let pairs = [];
  if (event.values && typeof event.values === 'object' && !Array.isArray(event.values)) {
    pairs = Object.entries(event.values);
  } else if (event.step !== undefined && Object.prototype.hasOwnProperty.call(event, 'value')) {
    pairs = [[event.step, event.value]];
  } else if (event.key !== undefined && Object.prototype.hasOwnProperty.call(event, 'value')) {
    pairs = [[event.key, event.value]];
  }
  if (!pairs.length) return { result: fail('INVALID_EVENT', 'interview-answer requires values or step/value') };

  const accepted = [];
  const rejected = [];
  for (const [key, value] of pairs) {
    const step = INTERVIEW_STEPS.find(s => s.key === String(key))
      || (/^\d+$/.test(String(key)) ? INTERVIEW_STEPS.find(s => s.step === Number(key)) : null);
    if (!step) {
      rejected.push({ key: String(key), reason: 'unknown interview step' });
      continue;
    }
    if (step.key === 'draft') continue;
    const valid = validateAnswer(step, value);
    if (!valid.ok) {
      rejected.push({ key: step.key, reason: valid.reason });
      continue;
    }
    if (step.key === 'workdir' && !workdirMatches(state.cwd, value)) {
      rejected.push({ key: step.key, reason: workdirMismatchReason(state.cwd, value) });
      continue;
    }
    state.interview.answers[step.key] = step.key === 'workdir'
      ? state.cwd
      : normalizeAnswer(step, value);
    accepted.push(step.key);
  }

  if (!accepted.length) {
    return { result: fail('INVALID_ANSWER', rejected.map(r => r.reason).join('; ') || 'no answer was accepted') };
  }

  state.interview.step = interviewStepIndex(state.interview.answers);
  const complete = REQUIRED_INTERVIEW_KEYS.every(k => textOf(state.interview.answers[k]));
  if (complete) {
    const previousVersion = state.interview.draft?.version || 0;
    const built = buildInterviewDraft(state.interview.answers, {
      runId: state.runId,
      version: previousVersion + 1,
      now: at,
      cwd: state.cwd,
      mode: state.mode,
      originalRequest: state.originalRequest,
      confirmedCommand: state.spec.confirmedCommand,
      defaultAcceptance: state.spec.confirmedCommand,
      files: state.spec.files,
    });
    if (!built.ok) {
      return { result: fail('DRAFT_INVALID', built.errors.map(e => e.reason).join('; ')) };
    }
    state.interview.draft = built.draft;
    state.interview.step = 9;
    state.status = 'awaiting-confirm';
    state.interview.skipped = false;
    state.interview.confirmation = null;
    state.spec.frozen = false;
    state.spec.token = null;
    state.spec.version = 0;
    pushTrace(state, at, 'draft', `draft rebuilt v${built.draft.version}; awaiting manual confirmation`);
  }

  return {
    result: ok({ accepted, rejected, draft: state.interview.draft }),
  };
}

function validateAnswer(step, value) {
  if (step.kind === 'choice' && step.multiple) {
    const mapped = mapIntegrityRestrictions(value);
    if (mapped.mode === 'invalid') {
      return { ok: false, reason: mapped.reason };
    }
    return { ok: true };
  }
  if (step.kind === 'choice') {
    const text = textOf(value, 64);
    if (!(step.options || []).some(o => o.value === text)) {
      return { ok: false, reason: `expected one of: ${(step.options || []).map(o => o.value).join(', ')}` };
    }
    return { ok: true };
  }
  if (step.required && !textOf(value)) {
    return { ok: false, reason: `${step.key} is required` };
  }
  return { ok: true };
}

function normalizeAnswer(step, value) {
  if (step.kind === 'choice' && step.multiple) {
    return mapIntegrityRestrictions(value).selected.join(',');
  }
  return textOf(value, step.key === 'objective' || step.key === 'deliverables' ? 8192 : 4096);
}

function leaseBlocked(state, event, at) {
  if (state.lock && state.lock.expiresAt > at) {
    if (!event.leaseToken) return fail('LEASE_REQUIRED', 'active lease requires a leaseToken');
    if (String(event.leaseToken) !== state.lock.token) {
      return fail('LEASE_MISMATCH', 'leaseToken does not own the active lock');
    }
  }
  return null;
}

function roleStarted(state, event, at) {
  if (state.status !== 'running') {
    if (state.status === 'verifying') return { result: fail('WRONG_STATUS', 'all tasks already passed; audit is pending') };
    return { result: fail('WRONG_STATUS', `role-started is not valid while ${state.status}`) };
  }
  const leaseFailure = leaseBlocked(state, event, at);
  if (leaseFailure) return { result: leaseFailure };

  const task = state.plan.tasks.find(t => t.id === event.taskId);
  if (!task) return { result: fail('UNKNOWN_TASK', `unknown task: ${event.taskId}`) };
  if (event.role && event.role !== task.role) {
    return { result: fail('ROLE_MISMATCH', `task ${task.id} has role ${task.role}`) };
  }
  const childSessionId = textOf(event.childSessionId, 256);
  if (!childSessionId) return { result: fail('CHILD_SESSION_REQUIRED', 'childSessionId is required') };

  if (task.status === 'running') {
    if (task.childSessionId === childSessionId) {
      return { result: ok({ code: 'ALREADY_STARTED', taskId: task.id }) };
    }
    return { result: fail('TASK_BUSY', `task ${task.id} is already running`) };
  }
  if (!['dispatched', 'pending'].includes(task.status)) {
    return { result: fail('INVALID_TASK_STATE', `task ${task.id} is ${task.status}`) };
  }
  if (task.status === 'pending') {
    const depsMet = task.deps.every(id => {
      const dep = state.plan.tasks.find(t => t.id === id);
      return dep && dep.status === 'pass';
    });
    if (!depsMet) return { result: fail('DEPENDENCY_NOT_MET', `task ${task.id} has unmet dependencies`) };
  }
  if (state.stats.dispatches >= state.policy.maxDispatches) {
    return { result: fail('DISPATCH_BUDGET_EXCEEDED', `maxDispatches=${state.policy.maxDispatches} reached`) };
  }

  task.status = 'running';
  task.childSessionId = childSessionId;
  task.startedAt = at;
  task.attempts += 1;
  state.stats.dispatches += 1;
  state.succession.spawnCount = state.stats.dispatches;
  recordProgress(state, at);

  const effects = [];
  if (state.succession.spawnCount >= state.succession.threshold && !state.succession.required) {
    state.succession.required = true;
    effects.push('succession-required');
    pushTrace(state, at, 'succession', `succession required at ${state.succession.spawnCount} spawns`);
  }
  pushTrace(state, at, 'role-started', `${task.role} ${task.id}`);
  return { result: ok({ taskId: task.id, role: task.role }), effects };
}

function roleResult(state, event, at) {
  if (!['running', 'verifying'].includes(state.status)) {
    return { result: fail('WRONG_STATUS', `role-result is not valid while ${state.status}`) };
  }
  const leaseFailure = leaseBlocked(state, event, at);
  if (leaseFailure) return { result: leaseFailure };

  const task = state.plan.tasks.find(t => t.id === event.taskId);
  if (!task) return { result: fail('UNKNOWN_TASK', `unknown task: ${event.taskId}`) };
  if (event.role && event.role !== task.role) {
    return { result: fail('ROLE_MISMATCH', `task ${task.id} has role ${task.role}`) };
  }
  if (!event.childSessionId || event.childSessionId !== task.childSessionId) {
    return { result: fail('IDENTITY_MISMATCH', 'childSessionId does not match the started task') };
  }
  if (task.status === 'pass' || task.status === 'fail') {
    return { result: ok({ code: 'DUPLICATE_RESULT', ignored: true }) };
  }
  if (task.status !== 'running') {
    return { result: fail('INVALID_TASK_STATE', `task ${task.id} is ${task.status}`) };
  }

  const outcome = textOf(event.outcome, 32);
  if (!['pass', 'fail', 'error', 'veto'].includes(outcome)) {
    return { result: fail('INVALID_OUTCOME', 'outcome must be pass, fail, error, or veto') };
  }
  const verdict = event.verdict && typeof event.verdict === 'object' ? event.verdict : {};
  const warnings = [];
  if (Array.isArray(event.issues) && event.issues.length) {
    warnings.push('role-result.issues ignored; use open-issue');
  }

  task.finishedAt = at;
  task.outcome = outcome;
  const failureCause = verdict.reason || event.reason;
  task.failureReason = middleText(failureCause, 2048);
  task.failureIdentity = textOf(verdict.reasonDigest || event.reasonDigest, 64)
    || reasonDigest(failureCause);
  if (event.report) task.report = textOf(event.report, 1600);

  if (event.evidence) {
    const evidence = boundEvidence(event.evidence);
    state.evidence.latest = evidence;
    state.evidence.history.push({ taskId: task.id, at, evidence });
    if (state.evidence.history.length > EVIDENCE_HISTORY_LIMIT) {
      state.evidence.history.splice(0, state.evidence.history.length - EVIDENCE_HISTORY_LIMIT);
    }
  }

  const veto = outcome === 'veto'
    || verdict.outcome === 'veto'
    || verdict.integrityViolation === true;
  if (veto) {
    task.status = 'fail';
    state.stats.tasksFailed += 1;
    state.gate.integrityViolation = true;
    const effects = integrityFailure(
      state, at,
      textOf(verdict.reason || event.reason, 1024) || 'integrity veto',
    );
    return { result: ok({ warnings }), effects };
  }

  if (outcome === 'pass' && verdict.outcome !== 'fail') {
    task.status = 'pass';
    state.stats.tasksDone += 1;
    recordProgress(state, at);
    pushTrace(state, at, 'role-result', `${task.role} ${task.id} pass`);
    const advanced = evaluateGate(state, at);
    return { result: ok({ warnings }), effects: advanced.effects };
  }

  task.status = 'fail';
  state.stats.tasksFailed += 1;
  pushTrace(state, at, 'role-result', `${task.role} ${task.id} ${outcome}`);
  const advanced = evaluateGate(state, at);
  return { result: ok({ warnings }), effects: advanced.effects };
}

function openIssue(state, event, at) {
  if (!['running', 'verifying', 'paused'].includes(state.status)) {
    return { result: fail('INVALID_STATE', `open-issue is not valid while ${state.status}`) };
  }
  const input = event.issue && typeof event.issue === 'object' ? event.issue : {};
  const severity = normalizeSeverity(input.severity);
  const summary = issueSummary(input);
  if (!summary) return { result: fail('INVALID_ISSUE', 'issue.summary is required') };
  const source = textOf(input.source, 64) || 'reviewer';

  if (severity === 'integrity') {
    const effects = integrityFailure(state, at, summary);
    return {
      result: ok({ issueId: `ISS-${state.ledger.nextId}`, integrity: true }),
      effects,
    };
  }

  const existing = state.ledger.open.find(i => i.summary === summary && i.source === source && i.round === state.rounds.current);
  if (existing) {
    return { result: ok({ issueId: existing.id, deduplicated: true }) };
  }

  if (state.ledger.open.length >= OPEN_LEDGER_LIMIT) {
    let marker = state.ledger.open.find(i => i.id === 'ISS-OVERFLOW');
    if (!marker) {
      marker = {
        id: 'ISS-OVERFLOW',
        severity: 'high',
        summary: 'additional open issues omitted; ledger bound reached',
        evidence: '',
        source: 'ledger',
        status: 'open',
        round: state.rounds.current,
        openedAt: at,
        overflowCount: 0,
      };
      state.ledger.open.push(marker);
      pushTrace(state, at, 'ledger-overflow', 'open issue ledger reached bound; marker added');
    }
    marker.overflowCount = (marker.overflowCount || 0) + 1;
    marker.summary = `additional open issues omitted; ledger bound reached (${marker.overflowCount} omitted)`;
    return { result: ok({ issueId: marker.id, overflow: true }) };
  }

  const issue = {
    id: `ISS-${state.ledger.nextId++}`,
    severity,
    summary,
    evidence: issueEvidence(input),
    source,
    status: 'open',
    round: state.rounds.current,
    openedAt: at,
  };
  state.ledger.open.push(issue);
  pushTrace(state, at, 'open-issue', `${issue.id} ${severity} ${summary.slice(0, 100)}`);
  return { result: ok({ issueId: issue.id }) };
}

function closeIssue(state, event, at) {
  if (isTerminalStatus(state.status)) return { result: fail('TERMINAL', 'campaign is terminal') };
  const id = textOf(event.issueId, 64);
  if (!id) return { result: fail('INVALID_ISSUE', 'issueId is required') };
  const index = state.ledger.open.findIndex(i => i.id === id);
  if (index < 0) return { result: fail('UNKNOWN_ISSUE', `no open issue ${id}`) };
  const evidence = typeof event.evidence === 'string'
    ? event.evidence.trim()
    : event.evidence
      ? JSON.stringify(event.evidence)
      : '';
  if (!evidence) {
    return { result: fail('EVIDENCE_REQUIRED', 'closing an issue requires evidence') };
  }

  const [issue] = state.ledger.open.splice(index, 1);
  const closed = {
    ...issue,
    status: 'closed',
    closedAt: at,
    closedBy: textOf(event.closedBy, 64) || 'manual-chat',
    closeEvidence: textOf(evidence, EVIDENCE_LIMIT),
  };
  state.ledger.closed.push(closed);
  if (state.ledger.closed.length > CLOSED_LEDGER_LIMIT) {
    state.ledger.closed.splice(0, state.ledger.closed.length - CLOSED_LEDGER_LIMIT);
  }
  pushTrace(state, at, 'close-issue', `${id} closed with evidence`);
  return { result: ok({ issueId: id }) };
}

function auditResult(state, event, at) {
  if (state.status !== 'verifying') {
    return { result: fail('WRONG_STATUS', `audit-result is not valid while ${state.status}`) };
  }
  const veto = event.verdict === 'veto';
  if (event.independent !== true || event.freshContext !== true) {
    return { result: fail('NOT_INDEPENDENT', 'victory audit must be independent and fresh-context') };
  }
  const auditorSessionId = textOf(event.auditorSessionId, 256);
  if (!auditorSessionId) return { result: fail('INVALID_AUDIT', 'auditorSessionId is required') };
  const knownSessions = state.plan.tasks.map(t => t.childSessionId).filter(Boolean);
  const usedChildren = new Set(knownSessions);
  usedChildren.add(state.rootSessionId || '');
  usedChildren.add(state.rootSessionKey || '');
  if (usedChildren.has(auditorSessionId)) {
    return { result: fail('NOT_INDEPENDENT', 'auditorSessionId already participated in the run') };
  }

  const phases = event.phases && typeof event.phases === 'object' ? event.phases : {};
  const evidence = event.evidence && typeof event.evidence === 'object' ? event.evidence : {};
  const reason = textOf(event.reason, 1024);

  state.audit.auditorSessionId = auditorSessionId;
  state.audit.independent = true;
  state.audit.freshContext = true;

  // A veto is binary and must dominate conflicting evidence or missing phases.
  if (veto) {
    state.audit.status = 'vetoed';
    state.audit.verdict = 'veto';
    state.audit.reason = reason || 'victory auditor integrity veto';
    state.audit.phases = {
      a: phases.a || 'fail',
      b: phases.b || 'fail',
      c: phases.c || 'fail',
    };
    state.audit.evidence = Object.keys(evidence).length ? boundEvidence(evidence) : null;
    const effects = integrityFailure(state, at, state.audit.reason);
    return { result: ok({ verdict: 'veto' }), effects };
  }

  const phaseKeys = ['a', 'b', 'c'];
  if (phaseKeys.some(k => phases[k] !== 'pass' && phases[k] !== 'fail')) {
    return { result: fail('INVALID_AUDIT', 'audit must report phases a, b, and c') };
  }
  const allPhasesPass = phaseKeys.every(k => phases[k] === 'pass');
  if (event.verdict === 'pass' && !allPhasesPass) {
    return { result: fail('INVALID_AUDIT', 'passing audit requires all of a, b, and c to pass') };
  }

  const command = textOf(evidence.command, 4096);
  const expected = textOf(state.spec.confirmedCommand, 4096);
  if (!command || (expected && command !== expected)) {
    return { result: fail('INVALID_EVIDENCE', 'audit evidence command must match the frozen acceptance command') };
  }
  if (evidence.exitCode !== 0) {
    return { result: fail('INVALID_EVIDENCE', 'audit evidence must have exitCode 0') };
  }

  state.audit.verdict = event.verdict;
  state.audit.reason = reason || null;
  state.audit.phases = {
    a: phases.a,
    b: phases.b,
    c: phases.c,
  };
  state.audit.evidence = boundEvidence(evidence);

  if (event.verdict === 'fail') {
    state.audit.attempts += 1;
    pushTrace(state, at, 'audit', `audit fail attempt ${state.audit.attempts}`);
    const maxAttempts = state.plan.audit?.maxAttempts || 2;
    if (state.audit.attempts >= maxAttempts) {
      return {
        result: ok({ verdict: 'fail', attempts: state.audit.attempts }),
        effects: failCampaign(state, at, 'AUDIT_FAILED', 'victory audit failed twice'),
      };
    }
    state.audit.status = 'pending';
    const next = startNextRound(state, at, [], 'audit');
    return { result: ok({ verdict: 'fail', attempts: state.audit.attempts }), effects: next.effects };
  }

  if (event.verdict !== 'pass') {
    return { result: fail('INVALID_AUDIT', 'verdict must be pass, fail, or veto') };
  }

  state.audit.status = 'passed';
  state.audit.verifiedCommand = command;
  state.gate.decision = 'pass';
  state.status = 'done';
  state.failure = null;
  recordProgress(state, at);
  pushTrace(state, at, 'done', 'independent victory audit passed');
  return { result: ok({ verdict: 'pass' }), effects: ['stop'] };
}

function resumeCampaign(state, event, at) {
  if (event.source !== 'manual-chat') return { result: fail('NOT_MANUAL', 'resume must come from manual chat') };
  if (state.status !== 'paused') return { result: fail('WRONG_STATUS', `campaign is ${state.status}`) };
  if (state.spec.workdir && !workdirMatches(state.cwd, state.spec.workdir)) {
    return { result: fail('WORKDIR_MISMATCH', workdirMismatchReason(state.cwd, state.spec.workdir)) };
  }
  const resumeAudit = state.audit.status === 'pending' && state.plan.tasks.length > 0 && state.plan.tasks.every(task => task.status === 'pass');
  state.status = resumeAudit ? 'verifying' : 'running';
  state.failure = null;
  recordProgress(state, at);
  const effects = resumeAudit ? ['request-audit'] : [];
  for (const task of state.plan.tasks) {
    if (task.status === 'pass') continue;
    const depsMet = task.deps.every(id => {
      const dep = state.plan.tasks.find(t => t.id === id);
      return dep && dep.status === 'pass';
    });
    if (!depsMet) continue;
    if (task.status === 'running' && task.childSessionId) {
      // A restarted process cannot resume the old child; make the task visible
      // for a deliberate re-dispatch instead of pretending it is still running.
      task.status = 'dispatched';
      task.childSessionId = null;
      effects.push(`dispatch:${task.id}`);
    } else if (task.status === 'fail' || task.status === 'pending') {
      task.status = 'dispatched';
      task.childSessionId = null;
      effects.push(`dispatch:${task.id}`);
    }
  }
  pushTrace(state, at, 'resumed', 'manual resume');
  return { result: ok(), effects };
}

/**
 * Create a campaign state.  Pure and side-effect free.
 */
export function createCampaignState(input = {}) {
  const mode = input.mode;
  if (!MODES.includes(mode)) {
    throw new Error(`MODE_REQUIRED: mode must be one of ${MODES.join(', ')}`);
  }
  const at = nowOf(input.now);
  const policy = {
    ...DEFAULT_POLICY,
    ...(input.policy && typeof input.policy === 'object' ? input.policy : {}),
  };
  if (Number.isInteger(input.maxRounds) && input.maxRounds > 0) {
    policy.maxRounds = input.maxRounds;
  }
  if (Number.isInteger(input.ttlMs) && input.ttlMs > 0) policy.ttlMs = input.ttlMs;
  if (Number.isInteger(input.stallMs) && input.stallMs > 0) policy.stallMs = input.stallMs;
  if (Number.isInteger(input.maxDispatches) && input.maxDispatches > 0) {
    policy.maxDispatches = input.maxDispatches;
  }
  if (!Number.isInteger(policy.maxRounds) || policy.maxRounds < 1) {
    policy.maxRounds = DEFAULT_POLICY.maxRounds;
  }
  if (!Number.isInteger(policy.maxDispatches) || policy.maxDispatches < 1) {
    policy.maxDispatches = DEFAULT_POLICY.maxDispatches;
  }
  policy.maxRounds = Math.min(DEFAULT_POLICY.maxRounds, policy.maxRounds);
  policy.maxDispatches = Math.min(DEFAULT_POLICY.maxDispatches, policy.maxDispatches);
  if (Number.isInteger(input.successionThreshold) && input.successionThreshold > 0) {
    policy.successionThreshold = input.successionThreshold;
  }

  const cwd = textOf(input.cwd, 4096) || process.cwd();
  const route = MODES.includes(input.route) ? input.route : (mode === 'general' ? 'general' : 'swe-light');
  const runId = textOf(input.runId, 128) || makeRunId();
  const originalRequest = textOf(input.originalRequest || input.request || input.text, 16384);
  const confirmedCommand = textOf(input.confirmedCommand, 4096);

  const state = {
    schemaVersion: 1,
    runId,
    rootSessionId: textOf(input.rootSessionId, 256) || null,
    rootSessionKey: textOf(input.rootSessionKey, 256) || null,
    cwd,
    mode,
    route,
    status: 'draft',
    revision: 0,
    createdAt: at,
    updatedAt: at,
    expiresAt: at + policy.ttlMs,
    lastProgressAt: at,
    lock: null,
    originalRequest,
    spec: emptySpec(cwd, confirmedCommand),
    interview: {
      step: 1,
      answers: {},
      skipped: false,
      draft: null,
      confirmation: null,
    },
    ledger: { open: [], closed: [], nextId: 1 },
    plan: emptyPlan(route, policy),
    rounds: {
      current: 1,
      max: policy.maxRounds,
      history: [],
      stalledAt: null,
      lastProgressAt: at,
      consecutiveFailures: 0,
      signature: null,
    },
    gate: {
      decision: 'pending',
      integrityViolation: false,
      required: [],
      verdicts: [],
      openIssueIds: [],
      lastEvaluatedAt: null,
    },
    audit: {
      status: 'idle',
      independent: null,
      freshContext: null,
      auditorSessionId: null,
      phases: null,
      attempts: 0,
      maxAttempts: 2,
      reason: null,
      verdict: null,
      verifiedCommand: null,
      evidence: null,
    },
    questions: { open: [], answered: [] },
    evidence: { latest: null, history: [] },
    trace: [],
    traceSeq: 0,
    failure: null,
    succession: {
      generation: 1,
      spawnCount: 0,
      threshold: policy.successionThreshold,
      required: false,
      handoffPath: null,
      successorSessionId: null,
    },
    stats: { dispatches: 0, tasksDone: 0, tasksFailed: 0, rounds: 0 },
    policy,
  };
  state.spec.files = normalizeFiles(input.files || input.evidenceFiles || input.answers?.files);
  pushTrace(state, at, 'created', `campaign ${runId} (${mode}/${route})`);

  if (input.skipInterview === true) {
    const built = buildInterviewDraft(
      input.answers && typeof input.answers === 'object' ? input.answers : {},
      {
        runId, version: 1, now: at, cwd, mode,
        originalRequest,
        confirmedCommand,
        defaultAcceptance: confirmedCommand,
        files: state.spec.files,
        skipInterview: true,
      },
    );
    if (!built.ok) {
      throw new Error(`INTERVIEW_INVALID: ${built.errors.map(e => e.reason).join('; ')}`);
    }
    if (!workdirMatches(cwd, built.draft.workdir)) {
      throw new Error(`WORKDIR_MISMATCH: ${workdirMismatchReason(cwd, built.draft.workdir)}`);
    }
    built.draft.workdir = cwd;
    built.draft.answers = { ...built.draft.answers, workdir: cwd };
    state.interview.answers = { ...built.draft.answers };
    state.interview.skipped = true;
    state.interview.step = 9;
    state.interview.draft = built.draft;
    state.status = 'awaiting-confirm';
    state.spec.text = built.draft.text;
    state.spec.originalRequest = originalRequest;
    pushTrace(state, at, 'draft', `skip-interview draft v${built.draft.version}; awaiting manual confirmation`);
  } else if (input.answers && typeof input.answers === 'object') {
    const applied = applyInterviewAnswersToState(state, input.answers, at);
    if (!applied.ok) {
      throw new Error(`INTERVIEW_INVALID: ${applied.reason}`);
    }
  }

  return serializeSafe(state);
}

function applyInterviewAnswersToState(state, answers, at) {
  for (const [key, value] of Object.entries(answers)) {
    const step = INTERVIEW_STEPS.find(s => s.key === key);
    if (!step || step.key === 'draft') continue;
    const valid = validateAnswer(step, value);
    if (!valid.ok) return { ok: false, reason: valid.reason };
    if (step.key === 'workdir' && !workdirMatches(state.cwd, value)) {
      return { ok: false, reason: `WORKDIR_MISMATCH: ${workdirMismatchReason(state.cwd, value)}` };
    }
    state.interview.answers[step.key] = step.key === 'workdir'
      ? state.cwd
      : normalizeAnswer(step, value);
  }
  state.interview.step = interviewStepIndex(state.interview.answers);
  if (REQUIRED_INTERVIEW_KEYS.every(k => textOf(state.interview.answers[k]))) {
    const built = buildInterviewDraft(state.interview.answers, {
      runId: state.runId, version: 1, now: at, cwd: state.cwd, mode: state.mode,
      originalRequest: state.originalRequest, confirmedCommand: state.spec.confirmedCommand,
      defaultAcceptance: state.spec.confirmedCommand, files: state.spec.files,
    });
    if (!built.ok) return { ok: false, reason: built.errors.map(e => e.reason).join('; ') };
    state.interview.draft = built.draft;
    state.interview.step = 9;
    state.status = 'awaiting-confirm';
  }
  return { ok: true };
}

/**
 * Pure reducer.  Never mutates its input.
 */
export function reduceEvent(state, event = {}, opts = {}) {
  if (!state || typeof state !== 'object') throw new Error('state is required');
  if (!event || typeof event.type !== 'string') {
    return { state, result: fail('INVALID_EVENT', 'event.type is required'), effects: [] };
  }
  const at = nowOf(opts.now);

  if (event.expectedRevision !== undefined && Number(event.expectedRevision) !== Number(state.revision)) {
    return {
      state,
      result: fail('REVISION_CONFLICT', `expected revision ${event.expectedRevision}, current ${state.revision}`),
      effects: [],
    };
  }

  const next = clone(state);

  if (next.lock && next.lock.expiresAt <= at) {
    next.lock = null;
  }

  if (next.status !== 'cancelled' && isExpired(next, at) && event.type !== 'cancel') {
    return { state: next, result: fail('EXPIRED', 'campaign TTL has elapsed'), effects: ['stop'] };
  }
  if (isTerminalStatus(next.status)) {
    return { state: next, result: fail('TERMINAL', `campaign is ${next.status}`), effects: [] };
  }

  let outcome;
  switch (event.type) {
    case 'interview-answer':
      outcome = applyInterviewAnswer(next, event, at);
      break;
    case 'interview-draft': {
      if (!['draft', 'awaiting-confirm'].includes(next.status)) {
        outcome = { result: fail('INVALID_STATE', 'interview is no longer open') };
        break;
      }
      const built = buildInterviewDraft(next.interview.answers, {
        runId: next.runId,
        version: (next.interview.draft?.version || 0) + 1,
        now: at,
        cwd: next.cwd,
        mode: next.mode,
        originalRequest: next.originalRequest,
        confirmedCommand: next.spec.confirmedCommand,
        defaultAcceptance: next.spec.confirmedCommand,
        files: next.spec.files,
      });
      if (!built.ok) {
        outcome = { result: fail('DRAFT_INVALID', built.errors.map(e => e.reason).join('; ')) };
      } else if (!workdirMatches(next.cwd, built.draft.workdir)) {
        outcome = { result: fail('WORKDIR_MISMATCH', workdirMismatchReason(next.cwd, built.draft.workdir)) };
      } else {
        built.draft.workdir = next.cwd;
        next.interview.draft = built.draft;
        next.interview.step = 9;
        next.status = 'awaiting-confirm';
        outcome = { result: ok({ draft: built.draft }) };
      }
      break;
    }
    case 'confirm':
      outcome = applyConfirmation(next, event, at);
      break;
    case 'start':
      outcome = {
        result: fail(
          next.status === 'awaiting-confirm' ? 'CONFIRM_REQUIRED'
            : next.status === 'draft' ? 'INTERVIEW_INCOMPLETE'
              : next.status === 'paused' ? 'PAUSED'
                : 'BUSY',
          'use the explicit confirmation path to start a campaign',
        ),
      };
      break;
    case 'role-started':
      outcome = roleStarted(next, event, at);
      break;
    case 'role-result':
      outcome = roleResult(next, event, at);
      break;
    case 'open-issue':
      outcome = openIssue(next, event, at);
      break;
    case 'close-issue':
      outcome = closeIssue(next, event, at);
      break;
    case 'acceptance-failed': {
      const check = event.receipt;
      if (!['running', 'verifying'].includes(next.status) || !Number.isInteger(check?.exitCode) || !check.exitCode || check.command !== next.spec.confirmedCommand) {
        outcome = { result: fail('INVALID_EVIDENCE', 'expected failed receipt for the frozen command') };
        break;
      }
      const receipt = { command: check.command, exitCode: check.exitCode, stdout: textOf(check.stdout, 3000), stderr: textOf(check.stderr, 3000) };
      next.evidence.latest = receipt;
      next.evidence.history.push({ taskId: 'acceptance-check', at, evidence: receipt });
      next.evidence.history = next.evidence.history.slice(-EVIDENCE_HISTORY_LIMIT);
      next.gate.decision = 'retry';
      if (next.status === 'verifying') next.audit.evidence = receipt;
      const reason = `${event.stage}: acceptance exited ${check.exitCode}`;
      outcome = { result: ok(), effects: pauseCampaign(next, at, 'ACCEPTANCE_FAILED', reason) };
      break;
    }
    case 'audit-result':
      outcome = auditResult(next, event, at);
      break;
    case 'pause':
      if (event.source !== 'manual-chat') {
        outcome = { result: fail('NOT_MANUAL', 'pause must come from manual chat') };
      } else if (!['running', 'verifying', 'paused'].includes(next.status)) {
        outcome = { result: fail('WRONG_STATUS', `campaign is ${next.status}`) };
      } else if (next.status === 'paused') {
        outcome = {
          result: ok({
            code: 'ALREADY_PAUSED',
            reason: next.failure?.reason || 'campaign is already paused',
          }),
          effects: [],
        };
      } else {
        const reason = textOf(event.reason, 1024) || 'paused from manual chat';
        const effects = pauseCampaign(next, at, 'MANUAL_PAUSE', reason);
        outcome = { result: ok(), effects };
      }
      break;
    case 'resume':
      outcome = resumeCampaign(next, event, at);
      break;
    case 'cancel':
      if (event.source !== 'manual-chat') {
        outcome = { result: fail('NOT_MANUAL', 'cancel must come from manual chat') };
      } else {
        next.status = 'cancelled';
        next.failure = null;
        pushTrace(next, at, 'cancelled', 'cancelled from manual chat');
        outcome = { result: ok(), effects: ['stop'] };
      }
      break;
    case 'recover':
      if (!['running', 'verifying', 'paused'].includes(next.status)) {
        outcome = { result: fail('WRONG_STATUS', `campaign is ${next.status}`) };
      } else {
        const effects = pauseCampaign(
          next, at, 'RESTART_REQUIRES_MANUAL',
          'process restart cannot resume a writing worker automatically; manual resume required',
        );
        outcome = { result: ok(), effects };
      }
      break;
    case 'tick': {
      if (!['running', 'verifying', 'paused'].includes(next.status)) {
        outcome = { result: fail('WRONG_STATUS', `campaign is ${next.status}`) };
        break;
      }
      if (next.status === 'paused') {
        outcome = { result: ok({ code: 'PAUSED' }) };
        break;
      }
      if (event.progress === true) recordProgress(next, at);
      pushTrace(next, at, 'tick', event.progress === true ? 'progress' : 'tick');
      if (at - next.lastProgressAt > next.policy.stallMs) {
        const effects = pauseCampaign(
          next, at, 'STALLED',
          `no progress for more than ${next.policy.stallMs}ms`,
        );
        outcome = { result: ok({ code: 'STALLED' }), effects };
      } else {
        outcome = { result: ok() };
      }
      break;
    }
    case 'succession-handoff':
      next.succession.generation += 1;
      next.succession.required = false;
      next.succession.spawnCount = 0;
      next.succession.handoffPath = textOf(event.handoffPath, 4096) || null;
      next.succession.successorSessionId = textOf(event.successorSessionId, 256) || null;
      pushTrace(next, at, 'succession', `handoff accepted; generation ${next.succession.generation}`);
      outcome = { result: ok({ generation: next.succession.generation }) };
      break;
    case 'spec-update':
      if (next.spec.frozen) {
        outcome = { result: fail('FROZEN_SPEC', 'spec is frozen; start a new campaign to change it') };
      } else if (event.patch && typeof event.patch === 'object') {
        if (event.patch.confirmedCommand) next.spec.confirmedCommand = textOf(event.patch.confirmedCommand, 4096);
        if (event.patch.acceptance) next.spec.acceptance = textOf(event.patch.acceptance, 4096);
        outcome = { result: ok({ specVersion: next.spec.version }) };
      } else {
        outcome = { result: fail('INVALID_EVENT', 'spec-update requires a patch') };
      }
      break;
    default:
      outcome = { result: fail('UNKNOWN_EVENT', `unknown event type: ${event.type}`) };
  }

  if (!outcome.result || outcome.result.ok !== true) {
    return { state, result: outcome.result || fail('INVALID_EVENT', 'event rejected'), effects: outcome.effects || [] };
  }

  bump(next, at);
  const effects = outcome.effects || [];
  if (!outcome.result.code && effects.length === 0) {
    // Event accepted; no explicit effects.
  }
  return { state: serializeSafe(next), result: outcome.result, effects };
}

export function isExpired(state, now = Date.now()) {
  return Number.isFinite(state?.expiresAt) && now > state.expiresAt;
}

export function canStart(state, opts = {}) {
  const at = nowOf(opts.now);
  if (isExpired(state, at)) return { ok: false, code: 'EXPIRED', reason: 'campaign TTL has elapsed' };
  if (isTerminalStatus(state.status)) {
    return { ok: false, code: 'TERMINAL', reason: `campaign is ${state.status}` };
  }
  if (opts.cwd && textOf(opts.cwd, 4096) !== state.cwd) {
    return { ok: false, code: 'CWD_MISMATCH', reason: `campaign cwd is ${state.cwd}` };
  }
  if (state.status === 'awaiting-confirm') {
    return { ok: false, code: 'CONFIRM_REQUIRED', reason: 'manual confirmation is required' };
  }
  if (state.status === 'draft') {
    return { ok: false, code: 'INTERVIEW_INCOMPLETE', reason: 'the interview is incomplete' };
  }
  if (state.status === 'paused') {
    return { ok: false, code: 'PAUSED', reason: state.failure?.reason || 'campaign is paused' };
  }
  if (state.status === 'running' || state.status === 'verifying') {
    if (state.lock && state.lock.expiresAt > at) {
      if (opts.leaseToken && String(opts.leaseToken) === state.lock.token) {
        return { ok: true, code: 'REENTRANT', reason: 'lease is held by this caller' };
      }
      return { ok: false, code: 'BUSY', reason: 'another host owns the campaign lease' };
    }
    return { ok: false, code: 'BUSY', reason: `campaign is ${state.status}` };
  }
  return { ok: false, code: 'NOT_STARTABLE', reason: `campaign is ${state.status}` };
}

export function validateConfirmation(state, confirmation = {}) {
  if (!state) return fail('INVALID_STATE', 'state is required');
  if (state.spec?.frozen) return fail('ALREADY_CONFIRMED', 'spec is already frozen');
  if (state.status !== 'awaiting-confirm' || !state.interview?.draft) {
    return fail('CONFIRM_REQUIRED', 'draft is not awaiting confirmation');
  }
  if (confirmation.source !== 'manual-chat') return fail('NOT_MANUAL', 'confirmation must come from manual chat');
  const draft = state.interview.draft;
  if (typeof confirmation.text !== 'string' || confirmation.text !== draft.confirmLine) {
    return fail('TEXT_MISMATCH', `expected exact text: ${draft.confirmLine}`);
  }
  if (Number(confirmation.version) !== Number(draft.version)) {
    return fail('STALE_VERSION', 'draft version is no longer current');
  }
  if (String(confirmation.token ?? '') !== draft.token) {
    return fail('STALE_TOKEN', 'draft token is no longer current');
  }
  if (!workdirMatches(state.cwd, draft.workdir)) {
    return fail('WORKDIR_MISMATCH', workdirMismatchReason(state.cwd, draft.workdir));
  }
  return ok();
}

export function acquireLease(state, opts = {}) {
  const at = nowOf(opts.now);
  const ownerId = textOf(opts.ownerId, 128) || 'unknown';
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : state.policy?.leaseMs || DEFAULT_POLICY.leaseMs;
  const next = clone(state);
  if (next.lock && next.lock.expiresAt > at && next.lock.ownerId !== ownerId) {
    return {
      state,
      result: fail('LOCKED', `lease is held by ${next.lock.ownerId} until ${next.lock.expiresAt}`),
    };
  }
  next.lock = {
    ownerId,
    token: makeLeaseToken(ownerId, at),
    acquiredAt: at,
    expiresAt: at + ttlMs,
  };
  bump(next, at);
  return { state: serializeSafe(next), result: ok({ token: next.lock.token }) };
}

export function releaseLease(state, opts = {}) {
  const at = nowOf(opts.now);
  const ownerId = textOf(opts.ownerId, 128) || 'unknown';
  const next = clone(state);
  if (!next.lock) return { state: next, result: fail('NOT_LOCKED', 'campaign has no lease') };
  if (next.lock.ownerId !== ownerId) {
    return { state, result: fail('LEASE_MISMATCH', `lease is held by ${next.lock.ownerId}`) };
  }
  next.lock = null;
  bump(next, at);
  return { state: serializeSafe(next), result: ok() };
}

export function planCampaign(state, opts = {}) {
  const base = state?.plan && Array.isArray(state.plan.tasks) && state.plan.tasks.length
    ? state.plan
    : null;
  let plan = base ? clone(base) : makePlan(state, Math.max(1, state?.rounds?.current || 1));

  if (Array.isArray(opts.roles)) {
    const wanted = new Set(opts.roles.map(r => String(r)));
    plan.tasks = plan.tasks.filter(t => wanted.has(t.role));
  } else if (opts.roles && typeof opts.roles === 'object') {
    for (const task of plan.tasks) {
      const override = opts.roles[task.role];
      if (typeof override === 'string' && override) task.preset = override;
      else if (override && typeof override === 'object' && typeof override.preset === 'string') {
        task.preset = override.preset;
      }
    }
  }
  plan.token = hashToken('plan', plan.tasks.map(t => [t.id, t.role, t.preset, t.deps, t.status]));
  return plan;
}

export function summarize(state) {
  const failure = state?.failure ? ` failure=${state.failure.code}` : '';
  const audit = state?.audit?.status ? ` audit=${state.audit.status}` : '';
  const lock = state?.lock ? ` lock=${state.lock.ownerId}` : '';
  return [
    `Teamwork ${state.runId} [${state.mode}/${state.route}]`,
    `status=${state.status}${failure}`,
    `round ${state.rounds.current}/${state.rounds.max}`,
    `open issues: ${state.ledger.open.length}`,
    `tasks ${state.stats.tasksDone}/${state.plan.tasks.length} done${audit}${lock}`,
  ].join(' | ');
}

export function buildHandoff(state) {
  const taskLines = state.plan.tasks.map(t =>
    `- ${t.id} (${t.role}): ${t.status}${t.outcome ? ` / ${t.outcome}` : ''}${t.failureReason ? ` — ${t.failureReason}` : ''}`,
  );
  const issueLines = state.ledger.open.map(i => `- ${i.id} [${i.severity}] ${i.summary}`);
  return [
    '## Observation',
    `Run ${state.runId} is ${state.status} on route ${state.route} (round ${state.rounds.current}/${state.rounds.max}).`,
    `Frozen acceptance command: ${state.spec.confirmedCommand || 'not set'}.`,
    `Tasks:`,
    ...taskLines,
    `Open issues (${state.ledger.open.length}):`,
    ...(issueLines.length ? issueLines : ['- none']),
    '',
    '## Logic Chain',
    `The campaign confirmed a frozen spec (v${state.spec.version}, token ${state.spec.token || 'none'}) and advanced only through role results.`,
    `Gate decision: ${state.gate.decision}; integrity violation: ${state.gate.integrityViolation}.`,
    `Open issues are owned by the ledger, not by reviewer silence.`,
    '',
    '## Caveats',
    `Failure: ${state.failure ? `${state.failure.code} — ${state.failure.reason}` : 'none'}.`,
    `No worker may be auto-restarted after a failure; a manual resume is required.`,
    `Writes are disabled while paused or failed.`,
    '',
    '## Conclusion',
    `Next action: ${state.status === 'paused' ? 'manual resume or cancel' : state.status === 'verifying' ? 'request an independent victory audit' : state.status === 'done' ? 'none' : 'continue dispatched tasks'}.`,
    `Generation ${state.succession.generation}; dispatches ${state.stats.dispatches}/${state.policy.maxDispatches}.`,
    '',
    '## Verification Method',
    `Re-run: ${state.spec.confirmedCommand || state.spec.acceptance || 'the frozen acceptance command'}.`,
    `Check the campaign state JSON and trace before acting on this handoff; the successor must start from the store, not from this summary.`,
  ].join('\n');
}

function normalizeStoreEntries(entries) {
  if (entries instanceof Map) {
    return [...entries.entries()].map(([key, state]) => ({ key, state }));
  }
  if (Array.isArray(entries)) {
    return entries.map(entry => {
      if (Array.isArray(entry)) return { key: entry[0], state: entry[1] };
      return { key: entry.key, state: entry.state ?? entry.value };
    }).filter(e => e.key && e.state);
  }
  return [];
}

async function resolveStore(ctx, opts) {
  if (opts?.store) return opts.store;
  // Kept dynamic so the pure reducer and tests do not require a host store at
  // module-load time.  The host supplies src/store.js in production.
  const { openStore } = await import('./store.js');
  return openStore(ctx, opts);
}

function findStateEntry(entries, predicate) {
  return normalizeStoreEntries(entries).find(e => e.state && predicate(e.state, e.key)) || null;
}

function staleHandleResult(current, handle) {
  if (current && handle.state && current.runId !== handle.state.runId) {
    return {
      state: current,
      result: fail('STALE_HANDLE', 'the stored campaign was replaced by a newer run'),
    };
  }
  return null;
}

function makeHandle(store, key, state, defaults = {}) {
  const handle = {
    key,
    state,
    async refresh() {
      const fresh = await store.get(key);
      if (fresh) handle.state = fresh;
      return handle.state;
    },
    async persist() {
      const out = await store.transact(key, current => {
        const stale = staleHandleResult(current, handle);
        if (stale) return stale;
        return { state: handle.state, result: ok() };
      });
      await handle.refresh();
      return out;
    },
    async reduce(event, eventOpts = {}) {
      let reduced = null;
      const out = await store.transact(key, current => {
        const stale = staleHandleResult(current, handle);
        if (stale) return stale;
        const base = current || handle.state;
        reduced = reduceEvent(base, event, {
          now: eventOpts.now ?? defaults.now ?? Date.now(),
        });
        return {
          state: reduced.state,
          result: { ...reduced.result, effects: reduced.effects },
        };
      });
      // The store commits before resolving; refresh only after the commit, and
      // never mutate the handle from inside the transaction callback.
      const fresh = await store.get(key);
      if (fresh) handle.state = fresh;
      return {
        state: fresh || reduced?.state || handle.state,
        result: out,
        effects: out?.effects || [],
      };
    },
    plan(opts) {
      return planCampaign(handle.state, opts);
    },
    summarize() {
      return summarize(handle.state);
    },
    canStart(opts) {
      return canStart(handle.state, opts);
    },
    async acquireLease(opts = {}) {
      const out = await store.transact(key, current => {
        const stale = staleHandleResult(current, handle);
        if (stale) return stale;
        const applied = acquireLease(current || handle.state, opts);
        return { state: applied.state, result: applied.result };
      });
      await handle.refresh();
      return { state: handle.state, result: out };
    },
    async releaseLease(opts = {}) {
      const out = await store.transact(key, current => {
        const stale = staleHandleResult(current, handle);
        if (stale) return stale;
        const applied = releaseLease(current || handle.state, opts);
        return { state: applied.state, result: applied.result };
      });
      await handle.refresh();
      return { state: handle.state, result: out };
    },
  };
  return handle;
}

export async function createCampaign(ctx, input = {}, opts = {}) {
  const store = await resolveStore(ctx, opts);
  const key = textOf(opts.rootKey || input.rootSessionKey || input.rootSessionId || input.runId, 256)
    || `tw-${Date.now().toString(36)}`;
  const at = nowOf(opts.now ?? input.now);
  const requestedRunId = textOf(input.runId, 128);
  const result = await store.transact(key, current => {
    if (current && !isTerminalStatus(current.status)) {
      return {
        state: current,
        result: ok({ existing: true, runId: current.runId }),
      };
    }
    // Replacing a terminal run must never leave an old handle able to write to
    // the new run under the same root key.
    const runId = current && requestedRunId && requestedRunId === current.runId
      ? makeRunId()
      : requestedRunId || undefined;
    const state = createCampaignState({
      ...input,
      now: at,
      runId,
      rootSessionKey: input.rootSessionKey || key,
    });
    return {
      state,
      result: ok({ created: true, runId: state.runId }),
    };
  });
  const fresh = await store.get(key);
  return makeHandle(store, key, fresh, { now: opts.now });
}

export async function loadCampaign(ctx, rootSessionKey, opts = {}) {
  const store = await resolveStore(ctx, opts);
  const key = textOf(rootSessionKey, 256);
  if (!key) return null;
  let state = await store.get(key);
  let resolvedKey = key;
  if (!state) {
    const entries = await store.entries();
    const found = findStateEntry(entries, s => s.runId === key);
    if (found) {
      state = found.state;
      resolvedKey = found.key;
    }
  }
  if (!state) return null;
  return makeHandle(store, resolvedKey, state, { now: opts.now });
}

export async function findByRunId(ctx, runId, opts = {}) {
  const store = await resolveStore(ctx, opts);
  const wanted = textOf(runId, 256);
  if (!wanted) return null;
  const entries = await store.entries();
  const found = findStateEntry(entries, s => s.runId === wanted);
  if (!found) return null;
  return makeHandle(store, found.key, found.state, { now: opts.now });
}

export async function findByCwd(ctx, cwd, opts = {}) {
  const store = await resolveStore(ctx, opts);
  const wanted = textOf(cwd, 4096);
  const at = nowOf(opts.now);
  const entries = await store.entries();
  return normalizeStoreEntries(entries)
    .filter(({ state }) =>
      state && state.cwd === wanted
      && ACTIVE_STATUSES.includes(state.status)
      && !isExpired(state, at),
    )
    .map(({ key, state }) => ({
      key,
      state,
      status: state.status,
      runId: state.runId,
    }));
}

export async function cwdBusy(ctx, cwd, opts = {}) {
  const runs = await findByCwd(ctx, cwd, opts);
  const ignore = textOf(opts.ignoreRunId, 256);
  const run = ignore ? runs.find(r => r.runId !== ignore) : runs[0];
  return run ? { busy: true, run } : { busy: false, run: null };
}
