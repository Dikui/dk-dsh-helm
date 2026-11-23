import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUSES,
  createCampaignState,
  reduceEvent,
  planCampaign,
  summarize,
  canStart,
  isExpired,
  validateConfirmation,
  acquireLease,
  releaseLease,
  buildHandoff,
  createCampaign,
  loadCampaign,
  findByRunId,
  findByCwd,
  cwdBusy,
} from '../src/campaign.js';
import {
  INTERVIEW_STEPS,
  mapIntegrityRestrictions,
  buildInterviewDraft,
  validateInterviewAnswer,
} from '../src/interview.js';
import { buildRetryBrief } from '../src/host-runner.js';
import { createMemoryStore } from './support/memory-store.js';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
let tick = 0;
const at = () => NOW + ++tick * 1000;

function base(over = {}) {
  return {
    mode: 'swe-light',
    cwd: '/tmp/demo',
    rootSessionId: 'session-root',
    runId: 'tw-test-run',
    confirmedCommand: 'npm test',
    skipInterview: true,
    now: NOW,
    ...over,
  };
}

function step(state, event) {
  return reduceEvent(state, event, { now: at() });
}

function confirmedState(over = {}) {
  const state = createCampaignState(base(over));
  assert.equal(state.status, 'awaiting-confirm');
  const draft = state.interview.draft;
  const r = step(state, {
    type: 'confirm',
    text: draft.confirmLine,
    token: draft.token,
    version: draft.version,
    source: 'manual-chat',
  });
  assert.equal(r.result.ok, true, `confirm failed: ${r.result.code}`);
  assert.equal(r.state.status, 'running');
  return r.state;
}

function fullAnswers(over = {}) {
  return {
    objective: 'Build a deterministic ledger',
    users: 'Developers running long campaigns',
    restrictions: 'a,b,c,d',
    deliverables: 'src/ledger.js, tests',
    constraints: 'Node 22, no dependencies',
    acceptance: 'npm test',
    route: 'swe-light',
    workdir: '/tmp/demo',
    ...over,
  };
}

function taskOf(state, id) {
  const task = state.plan.tasks.find(t => t.id === id);
  assert.ok(task, `missing task ${id}`);
  return task;
}

function startTask(state, id, childSessionId) {
  const task = taskOf(state, id);
  const r = step(state, { type: 'role-started', taskId: id, role: task.role, childSessionId });
  assert.equal(r.result.ok, true, `start ${id} failed: ${r.result.code}`);
  return r.state;
}

function passTask(state, id, childSessionId, extra = {}) {
  const task = taskOf(state, id);
  const r = step(state, {
    type: 'role-result', taskId: id, role: task.role, childSessionId,
    outcome: 'pass', verdict: { outcome: 'pass', ...extra },
  });
  assert.equal(r.result.ok, true, `pass ${id} failed: ${r.result.code}`);
  return r;
}

function failTask(state, id, childSessionId, reason = 'failed') {
  const task = taskOf(state, id);
  const r = step(state, {
    type: 'role-result', taskId: id, role: task.role, childSessionId,
    outcome: 'fail', verdict: { outcome: 'fail', reason },
  });
  assert.equal(r.result.ok, true, `fail ${id} failed: ${r.result.code}`);
  return r;
}

// Mirrors the host runner: reviewer failures arrive as a string verdict plus a
// top-level reason, not as a nested verdict object.
function failReview(state, round, reason) {
  let s = completeSweRound(state, round);
  const r = step(s, {
    type: 'role-result', taskId: `review-r${round}`, role: 'reviewer',
    childSessionId: `rev-${round}`, outcome: 'fail', verdict: 'fail', reason,
  });
  assert.equal(r.result.ok, true, `review fail ${round} failed: ${r.result.code}`);
  return r;
}

function completeSweRound(state, round, child = `impl-${round}`) {
  let s = startTask(state, `impl-r${round}`, child);
  s = passTask(s, `impl-r${round}`, child).state;
  s = startTask(s, `review-r${round}`, `rev-${round}`);
  return s;
}

function passSweRound(state, round) {
  let s = completeSweRound(state, round);
  return passTask(s, `review-r${round}`, `rev-${round}`).state;
}

function audit(state, extra = {}) {
  return step(state, {
    type: 'audit-result',
    verdict: 'pass',
    phases: { a: 'pass', b: 'pass', c: 'pass' },
    independent: true,
    freshContext: true,
    auditorSessionId: 'auditor-fresh-1',
    evidence: { command: 'npm test', exitCode: 0, summary: 'test suite green' },
    ...extra,
  });
}

test('long-lived command handles timestamp later transitions using the live clock', async t => {
  const clock=t.mock.method(Date,'now',()=>NOW), store=createMemoryStore();
  const h=await createCampaign({},base({now:undefined}),{store});
  clock.mock.mockImplementation(()=>NOW+60_000);
  const d=h.state.interview.draft;
  const out=await h.reduce({type:'confirm',source:'manual-chat',text:d.confirmLine,token:d.token,version:d.version});
  assert.equal(out.result.ok,true);assert.equal(h.state.updatedAt,NOW+60_000);
});

function verifyState() {
  return passSweRound(confirmedState(), 1);
}

// ---------------------------------------------------------------------------
// Interview contract
// ---------------------------------------------------------------------------

test('INTERVIEW_STEPS exposes the fixed 9-step host contract', () => {
  assert.equal(INTERVIEW_STEPS.length, 9);
  for (const [i, s] of INTERVIEW_STEPS.entries()) {
    assert.equal(s.step, i + 1);
    assert.equal(typeof s.key, 'string');
    assert.equal(typeof s.title, 'string');
    assert.equal(typeof s.prompt, 'string');
    assert.equal(typeof s.required, 'boolean');
    assert.ok(['text', 'choice'].includes(s.kind));
    if (s.options) assert.ok(Array.isArray(s.options));
  }
  assert.deepEqual(INTERVIEW_STEPS.map(s => s.key), [
    'objective', 'users', 'restrictions', 'deliverables', 'constraints',
    'acceptance', 'route', 'workdir', 'draft',
  ]);
  assert.equal(INTERVIEW_STEPS[8].required, false);
  assert.ok(INTERVIEW_STEPS[2].options.some(o => o.value === 'e'));
});

test('reverse integrity mapping maps restriction selections to a mode', () => {
  assert.equal(mapIntegrityRestrictions('e').mode, 'development');
  assert.deepEqual(mapIntegrityRestrictions('e').notAllowed, []);
  assert.equal(mapIntegrityRestrictions('a,b,c').mode, 'demo');
  assert.equal(mapIntegrityRestrictions('a,b,c,d').mode, 'benchmark');
  assert.equal(mapIntegrityRestrictions('a').mode, 'demo');
  assert.equal(mapIntegrityRestrictions('a,e').mode, 'invalid');
  assert.equal(mapIntegrityRestrictions('').mode, 'invalid');
  const bench = mapIntegrityRestrictions('a,b,c,d');
  assert.equal(bench.standardLibraryOnly, true);
  assert.ok(bench.notAllowed.some(x => /open-source/i.test(x)));
});

test('validateInterviewAnswer accepts keys and step numbers', () => {
  assert.equal(validateInterviewAnswer('objective', 'Build a parser'), true);
  assert.equal(validateInterviewAnswer(1, 'Build a parser'), true);
  assert.equal(validateInterviewAnswer('restrictions', 'a,b,c,d'), true);
  const bad = validateInterviewAnswer('restrictions', 'z');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_RESTRICTIONS');
  assert.equal(validateInterviewAnswer('objective', '').ok, false);
});

test('skip-interview still produces a visible draft and waits for manual confirmation', () => {
  const state = createCampaignState(base());
  assert.equal(state.status, 'awaiting-confirm');
  assert.equal(state.interview.skipped, true);
  assert.equal(state.interview.step, 9);
  assert.equal(state.spec.frozen, false);
  const draft = state.interview.draft;
  assert.match(draft.text, /^BEGIN PROMPT/);
  assert.match(draft.text, /END PROMPT$/);
  assert.match(draft.text, /Integrity mode: development/);
  assert.equal(draft.confirmLine, `confirm ${state.runId} ${draft.token}`);
  assert.match(draft.token, /^tw1_/);

  const blocked = step(state, { type: 'start' });
  assert.equal(blocked.result.ok, false);
  assert.equal(blocked.result.code, 'CONFIRM_REQUIRED');

  const system = step(state, {
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'system',
  });
  assert.equal(system.result.ok, false);
  assert.equal(system.result.code, 'NOT_MANUAL');

  const wrong = step(state, {
    type: 'confirm', text: `${draft.confirmLine} `, token: draft.token,
    version: draft.version, source: 'manual-chat',
  });
  assert.equal(wrong.result.ok, false);
  assert.equal(wrong.result.code, 'TEXT_MISMATCH');
});

test('the interview workdir is fixed at draft creation and aliases normalize to the campaign cwd', () => {
  let state = createCampaignState({
    ...base(), skipInterview: false, confirmedCommand: undefined, mode: 'general',
  });
  const withoutWorkdir = fullAnswers();
  delete withoutWorkdir.workdir;
  let r = step(state, { type: 'interview-answer', values: withoutWorkdir });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.accepted.length, 7);

  r = step(r.state, { type: 'interview-answer', values: { workdir: '/tmp/other' } });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.code, 'INVALID_ANSWER');
  assert.match(r.result.reason, /@cwd \/tmp\/other/u);
  assert.equal(r.state.interview.answers.workdir, undefined);
  assert.equal(r.state.status, 'draft');

  r = step(r.state, { type: 'interview-answer', values: { workdir: '/tmp/demo/' } });
  assert.equal(r.result.ok, true);
  assert.deepEqual(r.result.accepted, ['workdir']);
  assert.equal(r.state.interview.answers.workdir, '/tmp/demo');
  assert.equal(r.state.interview.draft.workdir, '/tmp/demo');
  assert.match(r.state.interview.draft.text, /Workdir: \/tmp\/demo/u);
});

test('bulk answers and skip-interview reject a workdir outside the creation directory', () => {
  assert.throws(
    () => createCampaignState(base({ answers: fullAnswers({ workdir: '/tmp/other' }) })),
    error => /WORKDIR_MISMATCH/u.test(error.message) && /@cwd \/tmp\/other/u.test(error.message),
  );
  assert.throws(
    () => createCampaignState({
      ...base(), skipInterview: false, confirmedCommand: undefined, mode: 'general',
      answers: fullAnswers({ workdir: '/tmp/other' }),
    }),
    /WORKDIR_MISMATCH/u,
  );
});

test('confirmation rejects a legacy draft that names a different workdir', () => {
  const state = createCampaignState(base());
  const draft = state.interview.draft;
  const moved = { ...state, interview: { ...state.interview, draft: { ...draft, workdir: '/tmp/other' } } };
  const r = step(moved, {
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'manual-chat',
  });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.code, 'WORKDIR_MISMATCH');
  assert.match(r.result.reason, /@cwd \/tmp\/other/u);
  assert.equal(r.state.status, 'awaiting-confirm');
});

test('confirmation accepts an equivalent workdir spelling and freezes the creation cwd', () => {
  const state = createCampaignState(base());
  const draft = state.interview.draft;
  const equivalent = { ...state, interview: { ...state.interview, draft: { ...draft, workdir: '/tmp/demo/' } } };
  const r = step(equivalent, {
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'manual-chat',
  });
  assert.equal(r.result.ok, true, r.result.reason);
  assert.equal(r.state.status, 'running');
  assert.equal(r.state.spec.workdir, '/tmp/demo');
});

test('POSIX backslash is a filename character, not a directory separator', { skip: process.platform === 'win32' }, () => {
  const state = createCampaignState({
    ...base(), skipInterview: false, confirmedCommand: undefined, mode: 'general',
  });
  const answers = fullAnswers();
  delete answers.workdir;
  let r = step(state, { type: 'interview-answer', values: answers });
  assert.equal(r.result.ok, true);
  r = step(r.state, { type: 'interview-answer', values: { workdir: '/tmp/demo\\' } });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.code, 'INVALID_ANSWER');
  assert.match(r.result.reason, /@cwd \/tmp\/demo\\/u);
  assert.equal(r.state.interview.answers.workdir, undefined);
});

test('resume rejects a legacy paused run whose frozen workdir differs from its workspace', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  state = failTask(state, 'impl-r1', 'impl-1', 'real failure').state;
  const legacy = {
    ...state,
    spec: { ...state.spec, workdir: '/tmp/other' },
    failure: { ...state.failure, reason: 'real failure' },
  };
  const r = step(legacy, { type: 'resume', source: 'manual-chat' });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.code, 'WORKDIR_MISMATCH');
  assert.equal(r.state.status, 'paused');
  assert.equal(r.state.failure.code, 'ROLE_FAILED');
  assert.match(r.state.failure.reason, /real failure/u);
});

test('a second pause never overwrites the failure that actually paused the run', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  const failed = failTask(state, 'impl-r1', 'impl-1', 'real pause cause');
  state = failed.state;
  assert.equal(state.status, 'paused');
  assert.equal(state.failure.code, 'ROLE_FAILED');
  const originalReason = state.failure.reason;

  const second = step(state, {
    type: 'pause', source: 'manual-chat', reason: 'a later secondary pause',
  });
  assert.equal(second.result.ok, true);
  assert.equal(second.result.code, 'ALREADY_PAUSED');
  assert.equal(second.state.status, 'paused');
  assert.equal(second.state.failure.code, 'ROLE_FAILED');
  assert.equal(second.state.failure.reason, originalReason);
  assert.ok(!second.effects.includes('pause'));
});

test('a manual pause records the caller reason instead of a generic placeholder', () => {
  const state = confirmedState();
  const r = step(state, { type: 'pause', source: 'manual-chat', reason: 'paused by root session' });
  assert.equal(r.result.ok, true);
  assert.equal(r.state.failure.code, 'MANUAL_PAUSE');
  assert.equal(r.state.failure.reason, 'paused by root session');
});

test('frozen integrity restrictions and constraints reach the task prompt for execution and review', () => {
  const state = confirmedState({ answers: fullAnswers() });
  const prompts = state.plan.tasks.map(task => task.prompt).join('\n');
  assert.match(prompts, /Integrity mode: benchmark/u);
  assert.match(prompts, /dependencies outside the standard library/u);
  assert.match(prompts, /Standard library only: yes/u);
  assert.match(prompts, /Constraints: Node 22; no dependencies/u);
});

test('an interview answer can be applied in one batch and rebuilds the draft', () => {
  let state = createCampaignState({
    ...base(), skipInterview: false, confirmedCommand: undefined, mode: 'general',
  });
  assert.equal(state.status, 'draft');
  assert.equal(state.interview.draft, null);

  const answers = {
    objective: 'Build a deterministic ledger',
    users: 'Developers running long campaigns',
    restrictions: 'a,b,c,d',
    deliverables: 'src/ledger.js, tests',
    constraints: 'Node 22, no dependencies',
    acceptance: 'npm test',
    route: 'swe-light',
    workdir: '/tmp/demo',
  };
  const r = step(state, { type: 'interview-answer', values: answers });
  assert.equal(r.result.ok, true);
  assert.deepEqual(r.result.rejected, []);
  assert.equal(r.result.accepted.length, 8);
  state = r.state;
  assert.equal(state.status, 'awaiting-confirm');
  assert.equal(state.interview.step, 9);
  assert.equal(state.interview.answers.restrictions, 'a,b,c,d');
  assert.equal(state.interview.draft.integrity.mode, 'benchmark');
  assert.equal(state.interview.draft.route, 'swe-light');
  assert.match(state.interview.draft.text, /Build a deterministic ledger/);
});

test('partial interview answers stay in draft and reject invalid values', () => {
  let state = createCampaignState({ ...base(), skipInterview: false });
  const r = step(state, {
    type: 'interview-answer',
    values: { objective: 'Build it', restrictions: 'z' },
  });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.accepted.length, 1);
  assert.equal(r.result.rejected.length, 1);
  assert.equal(r.result.rejected[0].key, 'restrictions');
  assert.equal(r.result.draft, null);
  state = r.state;
  assert.equal(state.status, 'draft');
  assert.equal(state.interview.answers.objective, 'Build it');
  assert.equal(state.interview.answers.restrictions, undefined);
});

test('draft tokens go stale when answers change; old confirmation text/token is rejected', () => {
  let state = createCampaignState({ ...base(), skipInterview: false, files: ['boundary.mjs'] });
  const values = {
    objective: 'v1', users: 'u', restrictions: 'e', deliverables: 'd',
    constraints: 'c', acceptance: 'npm test', route: 'swe-light', workdir: '/tmp/demo',
  };
  state = step(state, { type: 'interview-answer', values }).state;
  const old = state.interview.draft;

  state = step(state, {
    type: 'interview-answer', values: { objective: 'v2' },
  }).state;
  const fresh = state.interview.draft;
  assert.deepEqual(fresh.files, ['boundary.mjs']);
  assert.deepEqual(step(state, {type:'interview-draft'}).state.interview.draft.files, fresh.files);
  assert.notEqual(fresh.token, old.token);
  assert.notEqual(fresh.confirmLine, old.confirmLine, 'a human repeating an old visible line must not authorize a revised spec');
  assert.equal(step(state,{type:'confirm',text:old.confirmLine,token:fresh.token,version:fresh.version,source:'manual-chat'}).result.code, 'TEXT_MISMATCH');
  assert.ok(fresh.version > old.version);

  const staleVersion = step(state, {
    type: 'confirm', text: fresh.confirmLine, token: fresh.token,
    version: old.version, source: 'manual-chat',
  });
  assert.equal(staleVersion.result.code, 'STALE_VERSION');

  const staleToken = step(state, {
    type: 'confirm', text: fresh.confirmLine, token: old.token,
    version: fresh.version, source: 'manual-chat',
  });
  assert.equal(staleToken.result.code, 'STALE_TOKEN');

  const textMismatch = step(state, {
    type: 'confirm', text: 'yes', token: fresh.token,
    version: fresh.version, source: 'manual-chat',
  });
  assert.equal(textMismatch.result.code, 'TEXT_MISMATCH');
});

test('confirmation freezes the spec and blocks later spec changes', () => {
  const state = confirmedState();
  assert.equal(state.spec.frozen, true);
  assert.equal(state.spec.version, 1);
  assert.equal(state.spec.token, state.interview.draft.token);
  assert.match(state.spec.originalRequest, /BEGIN PROMPT/);
  assert.equal(state.spec.confirmedCommand, 'npm test');

  const again = step(state, {
    type: 'confirm', text: state.interview.draft.confirmLine,
    token: state.spec.token, version: state.spec.version, source: 'manual-chat',
  });
  assert.equal(again.result.ok, false);
  assert.equal(again.result.code, 'ALREADY_CONFIRMED');

  const change = step(state, { type: 'spec-update', patch: { confirmedCommand: 'rm -rf /' } });
  assert.equal(change.result.ok, false);
  assert.equal(change.result.code, 'FROZEN_SPEC');

  assert.equal(validateConfirmation(state, {
    text: state.interview.draft.confirmLine, token: state.spec.token,
    version: state.spec.version, source: 'manual-chat',
  }).code, 'ALREADY_CONFIRMED');
});

test('relative evidence files are bounded and frozen into the spec', () => {
  const state = confirmedState({
    files: ['src/a.js', '/etc/passwd', '../escape.js', 'src/a.js', 'test/b.test.js', 'c.js', 'd.js'],
  });
  assert.deepEqual(state.spec.files, ['src/a.js', 'test/b.test.js', 'c.js', 'd.js']);
  assert.deepEqual(state.plan.tasks[0].prompt.match(/Files: (.+)/)[1], 'src/a.js; test/b.test.js; c.js; d.js');
});

test('mode is mandatory and validated', () => {
  assert.throws(() => createCampaignState({ ...base(), mode: undefined }), /MODE_REQUIRED/);
  assert.throws(() => createCampaignState({ ...base(), mode: 'turbo' }), /MODE_REQUIRED/);
});

// ---------------------------------------------------------------------------
// Plan / routing
// ---------------------------------------------------------------------------

test('swe-light plan is serial implementer -> reviewer with bounded budget and write scopes', () => {
  const state = confirmedState();
  const plan = planCampaign(state);
  assert.equal(plan.route, 'swe-light');
  assert.deepEqual(plan.tasks.map(t => t.role), ['implementer', 'reviewer']);
  const impl = plan.tasks[0];
  const review = plan.tasks[1];
  assert.deepEqual(review.deps, [impl.id]);
  assert.deepEqual(impl.writeScope, ['workspace']);
  assert.deepEqual(review.writeScope, []);
  assert.equal(impl.promptIsComplete, false);
  assert.equal(review.issueProtocol, 'ISSUE|severity|summary|evidence');
  assert.equal(plan.audit.role, 'victory-auditor');
  assert.equal(plan.audit.maxAttempts, 2);
  assert.equal(plan.budget.maxRounds, 32);
  assert.ok(plan.token);
});

test('general plan contains survey, dual verification, and independent audit metadata', () => {
  const state = confirmedState({ mode: 'general', confirmedCommand: 'npm test' });
  const plan = planCampaign(state);
  const roles = plan.tasks.map(t => t.role);
  assert.equal(plan.route, 'general');
  for (const role of ['explorer', 'spec-miner', 'e2e-orchestrator', 'implementer', 'reviewer', 'challenger', 'forensic-auditor']) {
    assert.ok(roles.includes(role), `missing role ${role}`);
  }
  assert.equal(plan.tasks.filter(t => t.role === 'reviewer').length, 2);
  assert.equal(plan.tasks.filter(t => t.role === 'challenger').length, 2);
  assert.ok(plan.tasks.every(t => Array.isArray(t.writeScope)));
  assert.equal(plan.audit.independent, true);
  assert.equal(plan.audit.freshContext, true);
});

test('plan role overrides and role filtering are supported', () => {
  const state = confirmedState();
  const overridden = planCampaign(state, { roles: { implementer: 'custom:impl' } });
  assert.equal(overridden.tasks.find(t => t.role === 'implementer').preset, 'custom:impl');
  const onlyReview = planCampaign(state, { roles: ['reviewer'] });
  assert.deepEqual(onlyReview.tasks.map(t => t.role), ['reviewer']);
});

// ---------------------------------------------------------------------------
// Gate: strict AND, ledger persistence, integrity veto
// ---------------------------------------------------------------------------

test('swe-light happy path passes strict gate, requests independent audit, then done', () => {
  let state = confirmedState();
  assert.ok(state.plan.tasks.find(t => t.id === 'impl-r1').status === 'dispatched');

  state = startTask(state, 'impl-r1', 'impl-child-1');
  let r = passTask(state, 'impl-r1', 'impl-child-1');
  assert.equal(r.state.status, 'running');
  assert.ok(r.effects.includes('dispatch:review-r1'));
  state = r.state;

  state = startTask(state, 'review-r1', 'review-child-1');
  r = passTask(state, 'review-r1', 'review-child-1');
  state = r.state;
  assert.equal(state.status, 'verifying');
  assert.equal(state.gate.decision, 'pass');
  assert.equal(state.audit.status, 'pending');
  assert.ok(r.effects.includes('request-audit'));

  r = audit(state);
  state = r.state;
  assert.equal(r.result.ok, true);
  assert.equal(state.status, 'done');
  assert.equal(state.audit.status, 'passed');
});

test('all required gate roles are ANDed; one failing role retries the round', () => {
  let state = confirmedState({ mode: 'general' });
  // Complete survey + e2e track first.
  for (const id of ['explore-1', 'explore-2', 'explore-3', 'spec-miner', 'e2e-1']) {
    state = startTask(state, id, `child-${id}`);
    state = passTask(state, id, `child-${id}`).state;
  }
  assert.equal(taskOf(state, 'impl-r1').status, 'dispatched');
  state = startTask(state, 'impl-r1', 'impl-1');
  state = passTask(state, 'impl-r1', 'impl-1').state;

  for (const id of ['review-1-r1', 'review-2-r1', 'challenger-1-r1', 'challenger-2-r1', 'forensic-r1']) {
    state = startTask(state, id, `child-${id}`);
  }
  // One reviewer fails, the rest pass.
  state = failTask(state, 'review-2-r1', 'child-review-2-r1').state;
  for (const id of ['review-1-r1', 'challenger-1-r1', 'challenger-2-r1', 'forensic-r1']) {
    state = passTask(state, id, `child-${id}`).state;
  }
  assert.equal(state.status, 'running');
  assert.equal(state.gate.decision, 'retry');
  assert.equal(state.rounds.current, 2);
  assert.ok(state.plan.tasks.some(t => t.id === 'impl-r2'));
});

test('an unresolved issue keeps the ledger open even when a reviewer does not mention it again', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  state = passTask(state, 'impl-r1', 'impl-1').state;
  state = startTask(state, 'review-r1', 'review-1');

  const issue = step(state, {
    type: 'open-issue',
    issue: { severity: 'high', summary: 'missing edge case', source: 'reviewer' },
  });
  assert.equal(issue.result.ok, true);
  assert.ok(issue.result.issueId);
  state = issue.state;

  let r = passTask(state, 'review-r1', 'review-1');
  state = r.state;
  assert.equal(state.gate.decision, 'retry');
  assert.equal(state.ledger.open.length, 1);
  assert.equal(state.ledger.open[0].id, issue.result.issueId);

  // Round 2: reviewer says nothing about the old issue, so it must stay open.
  state = completeSweRound(state, 2);
  r = passTask(state, 'review-r2', 'rev-2');
  state = r.state;
  assert.equal(state.ledger.open.length, 1, 'silence must not clear the ledger');
  assert.equal(state.gate.decision, 'retry');
  assert.equal(state.rounds.current, 3);
});

test('only an evidence-backed close-issue clears a ledger item and unblocks the gate', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  state = passTask(state, 'impl-r1', 'impl-1').state;
  state = startTask(state, 'review-r1', 'review-1');
  const issue = step(state, {
    type: 'open-issue',
    issue: { severity: 'medium', summary: 'needs regression test', source: 'reviewer' },
  });
  state = issue.state;
  state = passTask(state, 'review-r1', 'review-1').state;
  assert.equal(state.rounds.current, 2);

  state = completeSweRound(state, 2);
  const noEvidence = step(state, {
    type: 'close-issue', issueId: issue.result.issueId, closedBy: 'reviewer',
  });
  assert.equal(noEvidence.result.ok, false);
  assert.equal(noEvidence.result.code, 'EVIDENCE_REQUIRED');

  state = step(state, {
    type: 'close-issue', issueId: issue.result.issueId,
    evidence: 'commit abc123 adds regression test and npm test passes',
    closedBy: 'reviewer',
  }).state;
  const r = passTask(state, 'review-r2', 'rev-2');
  state = r.state;
  assert.equal(state.ledger.open.length, 0);
  assert.equal(state.status, 'verifying');
  assert.equal(state.gate.decision, 'pass');
});

test('integrity veto is binary and never auto-retries', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  state = passTask(state, 'impl-r1', 'impl-1').state;
  state = startTask(state, 'review-r1', 'review-1');
  const task = taskOf(state, 'review-r1');
  const r = step(state, {
    type: 'role-result', taskId: 'review-r1', role: task.role,
    childSessionId: 'review-1', outcome: 'veto',
    verdict: { outcome: 'veto', reason: 'copied open-source core logic' },
  });
  assert.equal(r.result.ok, true);
  state = r.state;
  assert.equal(state.status, 'failed');
  assert.equal(state.gate.integrityViolation, true);
  assert.equal(state.failure.code, 'INTEGRITY_VETO');
  assert.ok(r.effects.includes('stop'));
  assert.ok(!r.effects.some(e => e === 'retry-round' || e.startsWith('dispatch:')));
});

test('open-issue integrity severity also triggers immediate veto', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  const r = step(state, {
    type: 'open-issue',
    issue: { severity: 'integrity', summary: 'hardcoded acceptance output', source: 'forensic' },
  });
  assert.equal(r.result.ok, true);
  assert.equal(r.state.status, 'failed');
  assert.equal(r.state.gate.integrityViolation, true);
});

test('role-result.issues is not a second ledger write path', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  const r = step(state, {
    type: 'role-result', taskId: 'impl-r1', role: 'implementer',
    childSessionId: 'impl-1', outcome: 'pass',
    issues: [{ severity: 'high', summary: 'should be ignored' }],
  });
  assert.equal(r.result.ok, true);
  assert.equal(r.state.ledger.open.length, 0);
  assert.ok(r.result.warnings.some(w => /use open-issue/.test(w)));
});

// ---------------------------------------------------------------------------
// Independent victory audit
// ---------------------------------------------------------------------------

test('victory audit must be independent, fresh-context, complete, and evidence-backed', () => {
  const state = verifyState();
  assert.equal(state.status, 'verifying');

  for (const bad of [
    audit(state, { independent: false }),
    audit(state, { freshContext: false }),
    audit(state, { phases: { a: 'pass', b: 'pass' } }),
    audit(state, { auditorSessionId: 'impl-1' }),
    audit(state, { auditorSessionId: 'rev-1' }),
    audit(state, { evidence: { command: 'echo fake', exitCode: 0 } }),
    audit(state, { evidence: { command: 'npm test', exitCode: 1 } }),
  ]) {
    assert.equal(bad.result.ok, false);
    assert.ok(['INVALID_AUDIT', 'NOT_INDEPENDENT', 'INVALID_EVIDENCE'].includes(bad.result.code), bad.result.code);
    assert.equal(bad.state.status, 'verifying');
  }

  const ok = audit(state);
  assert.equal(ok.result.ok, true);
  assert.equal(ok.state.status, 'done');
  assert.equal(ok.state.audit.verifiedCommand, 'npm test');
});

test('audit veto dominates missing phases and evidence', () => {
  const state = verifyState();
  const r = step(state, {
    type: 'audit-result', verdict: 'veto', independent: true,
    freshContext: true, auditorSessionId: 'auditor-veto',
  });
  assert.equal(r.result.ok, true);
  assert.equal(r.state.status, 'failed');
  assert.equal(r.state.failure.code, 'INTEGRITY_VETO');
  assert.equal(r.state.audit.status, 'vetoed');
  assert.equal(r.state.audit.reason, 'victory auditor integrity veto');
});

test('audit failure persists the persisted reason and reopens the loop, then terminates', () => {
  let state = verifyState();
  const first = step(state, {
    type: 'audit-result', verdict: 'fail',
    phases: { a: 'pass', b: 'pass', c: 'fail' },
    independent: true, freshContext: true, auditorSessionId: 'auditor-1',
    reason: 'phase c mismatch', evidence: { command: 'npm test', exitCode: 0 },
  });
  assert.equal(first.result.ok, true);
  state = first.state;
  assert.equal(state.audit.reason, 'phase c mismatch');
  assert.equal(state.status, 'running');
  assert.equal(state.rounds.current, 2);
  assert.equal(state.audit.attempts, 1);

  state = completeSweRound(state, 2);
  state = passTask(state, 'review-r2', 'rev-2').state;
  assert.equal(state.status, 'verifying');

  const second = step(state, {
    type: 'audit-result', verdict: 'fail',
    phases: { a: 'pass', b: 'pass', c: 'fail' },
    independent: true, freshContext: true, auditorSessionId: 'auditor-2',
    evidence: { command: 'npm test', exitCode: 0 },
  });
  assert.equal(second.result.ok, true);
  state = second.state;
  assert.equal(state.status, 'failed');
  assert.equal(state.failure.code, 'AUDIT_FAILED');
});

// ---------------------------------------------------------------------------
// Failure, stall, rounds, handoff
// ---------------------------------------------------------------------------

test('general survey failure pauses instead of leaving dependents permanently blocked', () => {
  let state = confirmedState({ mode: 'general' });
  state = startTask(state, 'explore-1', 'explore-child-1');
  const r = failTask(state, 'explore-1', 'explore-child-1', 'cannot read repository');
  state = r.state;
  assert.equal(state.status, 'paused');
  assert.equal(state.failure.code, 'SURVEY_FAILED');
  assert.ok(r.effects.includes('pause'));
  assert.ok(!r.effects.some(e => e.startsWith('dispatch:')));

  const resumed = step(state, { type: 'resume', source: 'manual-chat', reason: 'repo fixed' });
  assert.equal(resumed.result.ok, true);
  assert.equal(resumed.state.status, 'running');
  assert.ok(resumed.effects.includes('dispatch:explore-1'));
});

test('role failure pauses with writes disabled and never auto-dispatches a worker', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  const r = step(state, {
    type: 'role-result', taskId: 'impl-r1', role: 'implementer',
    childSessionId: 'impl-1', outcome: 'error', verdict: { outcome: 'error', reason: 'crash' },
  });
  assert.equal(r.result.ok, true);
  state = r.state;
  assert.equal(state.status, 'paused');
  assert.equal(state.failure.code, 'ROLE_FAILED');
  assert.equal(state.failure.writesAllowed, false);
  assert.equal(state.failure.requiresManualResume, true);
  assert.ok(r.effects.includes('pause'));
  assert.ok(!r.effects.some(e => e.startsWith('dispatch:')));

  const system = step(state, { type: 'resume', source: 'system' });
  assert.equal(system.result.code, 'NOT_MANUAL');
  const manual = step(state, { type: 'resume', source: 'manual-chat', reason: 'fixed environment' });
  assert.equal(manual.result.ok, true);
  state = manual.state;
  assert.equal(state.status, 'running');
  assert.ok(manual.effects.includes('dispatch:impl-r1'));
});

test('a reviewer process error pauses without auto-dispatching a worker', () => {
  let state = confirmedState();
  state = startTask(state, 'impl-r1', 'impl-1');
  state = passTask(state, 'impl-r1', 'impl-1').state;
  state = startTask(state, 'review-r1', 'review-1');
  const r = step(state, {
    type: 'role-result', taskId: 'review-r1', role: 'reviewer',
    childSessionId: 'review-1', outcome: 'error',
    verdict: { outcome: 'error', reason: 'reviewer process crashed' },
  });
  assert.equal(r.result.ok, true);
  assert.equal(r.state.status, 'paused');
  assert.equal(r.state.failure.code, 'ROLE_FAILED');
  assert.ok(!r.effects.some(e => e.startsWith('dispatch:')));
});

test('restart recovery always lands paused and requires explicit manual resume', () => {
  let state = confirmedState();
  const r = step(state, { type: 'recover', reason: 'process restarted' });
  assert.equal(r.result.ok, true);
  state = r.state;
  assert.equal(state.status, 'paused');
  assert.equal(state.failure.code, 'RESTART_REQUIRES_MANUAL');
  assert.equal(state.failure.writesAllowed, false);
  assert.ok(r.effects.includes('pause'));
});

test('stalled progress pauses the campaign', () => {
  let state = confirmedState();
  state = { ...state, lastProgressAt: NOW - 31 * 60 * 1000 };
  const r = reduceEvent(state, { type: 'tick' }, { now: NOW });
  assert.equal(r.result.ok, true);
  assert.equal(r.state.status, 'paused');
  assert.equal(r.state.failure.code, 'STALLED');
});

test('repeated identical failure signature triggers oscillation guard', () => {
  let state = confirmedState({ maxRounds: 5 });
  // Round 1 failure.
  state = startTask(state, 'impl-r1', 'impl-1');
  state = passTask(state, 'impl-r1', 'impl-1').state;
  state = startTask(state, 'review-r1', 'rev-1');
  state = failTask(state, 'review-r1', 'rev-1', 'same bug').state;
  assert.equal(state.rounds.current, 2);
  assert.equal(state.rounds.consecutiveFailures, 1);

  // Round 2 failure with the same signature.
  state = startTask(state, 'impl-r2', 'impl-2');
  state = passTask(state, 'impl-r2', 'impl-2').state;
  state = startTask(state, 'review-r2', 'rev-2');
  const r = failTask(state, 'review-r2', 'rev-2', 'same bug');
  state = r.state;
  assert.equal(state.status, 'paused');
  assert.equal(state.failure.code, 'OSCILLATION');
  assert.ok(r.effects.includes('pause'));
});

test('distinct verifier reasons stay distinct and do not trigger oscillation', () => {
  let state = confirmedState({ maxRounds: 5 });
  let r = failReview(state, 1, 'missing the negative-price edge case');
  state = r.state;
  assert.equal(state.status, 'running');
  assert.equal(state.rounds.current, 2);
  assert.equal(state.rounds.history.at(-1).failed[0].reason, 'missing the negative-price edge case');
  assert.match(buildRetryBrief(state), /missing the negative-price edge case/u);

  r = failReview(state, 2, 'rounding regression in the invoice total');
  state = r.state;
  assert.equal(state.status, 'running');
  assert.equal(state.rounds.current, 3);
  assert.equal(state.rounds.consecutiveFailures, 1);
  assert.equal(state.rounds.history.at(-1).failed[0].reason, 'rounding regression in the invoice total');
  const brief = buildRetryBrief(state);
  assert.match(brief, /rounding regression in the invoice total/u);
  assert.ok(!brief.includes('same failure signature repeated'));
});

test('verifier reasons that differ after a long shared prefix still do not oscillate', () => {
  const prefix = 'the same leading explanation '.repeat(24);
  let state = confirmedState({ maxRounds: 5 });
  state = failReview(state, 1, `${prefix} first root cause`).state;
  const r = failReview(state, 2, `${prefix} second root cause`);
  assert.equal(r.state.status, 'running');
  assert.equal(r.state.rounds.current, 3);
  assert.equal(r.state.rounds.consecutiveFailures, 1);
  assert.ok(!r.effects.includes('pause'));
});

test('the same verifier reason still trips the oscillation guard', () => {
  let state = confirmedState({ maxRounds: 5 });
  state = failReview(state, 1, 'the same unresolved bug').state;
  const r = failReview(state, 2, 'the same unresolved bug');
  assert.equal(r.state.status, 'paused');
  assert.equal(r.state.failure.code, 'OSCILLATION');
  assert.ok(r.effects.includes('pause'));
});

test('hard round cap stops at 32 by default, clamps higher input, and respects a lower override', () => {
  assert.equal(createCampaignState(base()).rounds.max, 32);
  assert.equal(createCampaignState(base({ maxRounds: 100 })).rounds.max, 32);
  const viaPolicy = createCampaignState(base({ policy: { maxRounds: 100, maxDispatches: 999 } }));
  assert.equal(viaPolicy.rounds.max, 32);
  assert.equal(viaPolicy.policy.maxDispatches, 40);

  let state = confirmedState({ maxRounds: 1 });
  state = startTask(state, 'impl-r1', 'impl-1');
  state = passTask(state, 'impl-r1', 'impl-1').state;
  state = startTask(state, 'review-r1', 'rev-1');
  const r = failTask(state, 'review-r1', 'rev-1', 'still broken');
  state = r.state;
  assert.equal(state.status, 'failed');
  assert.equal(state.failure.code, 'MAX_ROUNDS');
  assert.ok(!r.effects.includes('retry-round'));
});

test('succession is flagged at 16 dispatches and handoff records five sections', () => {
  let state = confirmedState({ mode: 'general' });
  const ids = ['explore-1', 'explore-2', 'explore-3', 'spec-miner', 'e2e-1'];
  for (const id of ids) {
    state = startTask(state, id, `child-${id}`);
    state = passTask(state, id, `child-${id}`).state;
  }
  state = startTask(state, 'impl-r1', 'impl-1');
  assert.equal(state.stats.dispatches, 6);
  state = passTask(state, 'impl-r1', 'impl-1').state;
  // Directly exercise the succession counter threshold without 16 real children.
  const synthetic = { ...state, stats: { ...state.stats, dispatches: 15 } };
  const r = step(synthetic, {
    type: 'role-started', taskId: 'review-1-r1', role: 'reviewer', childSessionId: 'rev-1',
  });
  assert.equal(r.result.ok, true, r.result.code);
  assert.equal(r.state.succession.required, true);
  assert.ok(r.effects.includes('succession-required'));

  const handoff = buildHandoff(r.state);
  for (const heading of ['Observation', 'Logic Chain', 'Caveats', 'Conclusion', 'Verification Method']) {
    assert.match(handoff, new RegExp(heading));
  }
  const handoffResult = step(r.state, {
    type: 'succession-handoff',
    handoffPath: '/tmp/demo/.agents/teamwork/handoff.md',
    successorSessionId: 'successor-1',
  });
  assert.equal(handoffResult.result.ok, true);
  assert.equal(handoffResult.state.succession.generation, 2);
  assert.equal(handoffResult.state.succession.required, false);
});

// ---------------------------------------------------------------------------
// Bounded state, expiry, concurrency
// ---------------------------------------------------------------------------

test('trace and open ledger stay bounded while preserving an overflow marker', () => {
  let state = confirmedState();
  for (let i = 0; i < 300; i++) {
    state = step(state, { type: 'tick', progress: true }).state;
  }
  assert.ok(state.trace.length <= 200);
  assert.ok(state.traceSeq >= 300);
  assert.ok(state.trace.at(-1).seq > state.trace[0].seq);

  for (let i = 0; i < 120; i++) {
    state = step(state, {
      type: 'open-issue',
      issue: { severity: 'low', summary: `issue ${i} ${'x'.repeat(12000)}`, source: 'reviewer' },
    }).state;
  }
  assert.ok(state.ledger.open.length <= 101);
  assert.ok(state.ledger.open.some(i => i.id === 'ISS-OVERFLOW'));
  for (const issue of state.ledger.open) assert.ok(issue.summary.length <= 9000);
  assert.ok(JSON.stringify(state).length < 512 * 1024);
});

test('worst-case ledger, trace, and evidence payloads stay under the state budget', () => {
  let state = confirmedState();
  const ids = [];
  for (let i = 0; i < 130; i++) {
    const r = step(state, {
      type: 'open-issue',
      issue: {
        severity: 'high',
        summary: `issue ${i} ${'x'.repeat(5000)}`,
        evidence: 'y'.repeat(5000),
        source: 'reviewer',
      },
    });
    state = r.state;
    if (r.result.issueId && !ids.includes(r.result.issueId)) ids.push(r.result.issueId);
  }
  for (let i = 0; i < 50; i++) {
    state = step(state, {
      type: 'close-issue', issueId: ids[i], evidence: 'z'.repeat(5000), closedBy: 'reviewer',
    }).state;
  }
  for (let i = 0; i < 200; i++) state = step(state, { type: 'tick', progress: true }).state;
  const serialized = JSON.stringify(state);
  assert.ok(state.ledger.open.length <= 81);
  assert.ok(state.ledger.closed.length <= 50);
  assert.ok(state.trace.length <= 100);
  assert.ok(serialized.length < 256 * 1024, `state is ${serialized.length} bytes`);
});

test('expired runs reject mutations and cannot start', () => {
  let state = createCampaignState(base({ ttlMs: 1000 }));
  const draft = state.interview.draft;
  const confirmed = reduceEvent(state, {
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'manual-chat',
  }, { now: NOW + 1 });
  assert.equal(confirmed.result.ok, true, confirmed.result.code);
  state = confirmed.state;
  assert.equal(isExpired(state, NOW + 500), false);
  assert.equal(isExpired(state, NOW + 5000), true);
  const r = reduceEvent(state, { type: 'tick', progress: true }, { now: NOW + 5000 });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.code, 'EXPIRED');
  assert.equal(canStart(state, { cwd: '/tmp/demo', now: NOW + 5000 }).code, 'EXPIRED');
});

test('revision and lease tokens protect re-entry races', () => {
  let state = confirmedState();
  const conflict = step(state, { type: 'tick', progress: true, expectedRevision: state.revision + 9 });
  assert.equal(conflict.result.code, 'REVISION_CONFLICT');
  assert.equal(conflict.state.revision, state.revision);

  const leased = acquireLease(state, { ownerId: 'host-a', now: at(), ttlMs: 60000 });
  assert.equal(leased.result.ok, true);
  state = leased.state;
  assert.ok(state.lock.token);

  const noLease = step(state, {
    type: 'role-started', taskId: 'impl-r1', role: 'implementer', childSessionId: 'impl-1',
  });
  assert.equal(noLease.result.code, 'LEASE_REQUIRED');

  const wrongLease = step(state, {
    type: 'role-started', taskId: 'impl-r1', role: 'implementer',
    childSessionId: 'impl-1', leaseToken: 'nope',
  });
  assert.equal(wrongLease.result.code, 'LEASE_MISMATCH');

  const okStart = step(state, {
    type: 'role-started', taskId: 'impl-r1', role: 'implementer',
    childSessionId: 'impl-1', leaseToken: state.lock.token,
  });
  assert.equal(okStart.result.ok, true);
  state = okStart.state;

  const blocked = acquireLease(state, { ownerId: 'host-b', now: at(), ttlMs: 60000 });
  assert.equal(blocked.result.ok, false);
  assert.equal(blocked.result.code, 'LOCKED');

  const wrongRelease = releaseLease(state, { ownerId: 'host-b', now: at() });
  assert.equal(wrongRelease.result.ok, false);
  const released = releaseLease(state, { ownerId: 'host-a', now: at() });
  assert.equal(released.result.ok, true);
  assert.equal(released.state.lock, null);
});

test('local store transactions are serialized and persisted', async () => {
  const store = createMemoryStore();
  const handle = await createCampaign({}, base(), { store, rootKey: 'root-1', now: NOW });
  assert.equal(handle.state.status, 'awaiting-confirm');
  const draft = handle.state.interview.draft;
  await handle.reduce({
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'manual-chat',
  }, { now: NOW + 1 });
  assert.equal(handle.state.status, 'running');

  const loaded = await loadCampaign({}, 'root-1', { store });
  assert.ok(loaded);
  assert.equal(loaded.state.runId, 'tw-test-run');

  const other = await loadCampaign({}, 'root-1', { store });
  const [a, b] = await Promise.all([
    handle.reduce({ type: 'tick', progress: true }, { now: NOW + 2 }),
    other.reduce({ type: 'tick', progress: true }, { now: NOW + 3 }),
  ]);
  assert.equal(a.result.ok, true);
  assert.equal(b.result.ok, true);
  const fresh = await loadCampaign({}, 'root-1', { store });
  assert.equal(fresh.state.revision, 3);
  assert.equal(other.state.revision, 3);
});

test('findByCwd and cwdBusy detect active runs across handles', async () => {
  const store = createMemoryStore();
  const h1 = await createCampaign({}, base(), { store, rootKey: 'root-a', now: NOW });
  assert.equal((await findByCwd({}, '/tmp/demo', { store, now: NOW })).length, 0, 'awaiting-confirm is not active');
  const draft = h1.state.interview.draft;
  await h1.reduce({
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'manual-chat',
  }, { now: NOW + 1 });

  const found = await findByCwd({}, '/tmp/demo', { store, now: NOW + 2 });
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'root-a');
  const busy = await cwdBusy({}, '/tmp/demo', { store, now: NOW + 2 });
  assert.equal(busy.busy, true);
  assert.equal(busy.run.runId, 'tw-test-run');
  assert.equal((await cwdBusy({}, '/tmp/demo', { store, now: NOW + 2, ignoreRunId: 'tw-test-run' })).busy, false);

  await h1.reduce({ type: 'cancel', source: 'manual-chat' }, { now: NOW + 3 });
  assert.equal((await findByCwd({}, '/tmp/demo', { store, now: NOW + 4 })).length, 0);
});

test('findByRunId and loadCampaign can resolve a run after a restart', async () => {
  const store = createMemoryStore();
  const created = await createCampaign({}, base(), { store, rootKey: 'root-run', now: NOW });
  const draft = created.state.interview.draft;
  await created.reduce({
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'manual-chat',
  }, { now: NOW + 1 });
  const found = await findByRunId({}, created.state.runId, { store, now: NOW + 2 });
  assert.ok(found);
  assert.equal(found.key, 'root-run');
  assert.equal(found.state.runId, created.state.runId);
  const byRunId = await loadCampaign({}, created.state.runId, { store });
  assert.ok(byRunId);
  assert.equal(byRunId.key, 'root-run');
  assert.equal(await findByRunId({}, 'missing-run', { store }), null);
});

test('a stale handle cannot overwrite a newer run under the same root key', async () => {
  const store = createMemoryStore();
  const old = await createCampaign({}, base(), { store, rootKey: 'root-stale', now: NOW });
  const draft = old.state.interview.draft;
  await old.reduce({
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'manual-chat',
  }, { now: NOW + 1 });
  await old.reduce({ type: 'cancel', source: 'manual-chat' }, { now: NOW + 2 });
  assert.equal(old.state.status, 'cancelled');

  const replacement = await createCampaign({}, base({ runId: 'tw-test-run' }), {
    store, rootKey: 'root-stale', now: NOW + 3,
  });
  assert.notEqual(replacement.state.runId, old.state.runId);
  const revision = replacement.state.revision;
  const stale = await old.reduce({ type: 'tick', progress: true }, { now: NOW + 4 });
  assert.equal(stale.result.ok, false);
  assert.equal(stale.result.code, 'STALE_HANDLE');
  assert.equal(replacement.state.revision, revision);
});

test('reducer results remain JSON-only and effects are exposed on handle results', async () => {
  const store = createMemoryStore();
  const handle = await createCampaign({}, base(), { store, rootKey: 'root-json', now: NOW });
  const draft = handle.state.interview.draft;
  const confirmed = await handle.reduce({
    type: 'confirm', text: draft.confirmLine, token: draft.token,
    version: draft.version, source: 'manual-chat',
  }, { now: NOW + 1 });
  assert.equal(confirmed.result.ok, true);
  assert.ok(confirmed.result.effects.includes('dispatch:impl-r1'));
  assert.deepEqual(confirmed.state, JSON.parse(JSON.stringify(confirmed.state)));
});

// ---------------------------------------------------------------------------
// Surface contract
// ---------------------------------------------------------------------------

test('canStart reports stable codes and summarize is human-readable', () => {
  const awaiting = createCampaignState(base());
  assert.equal(canStart(awaiting, { cwd: '/tmp/demo', now: NOW }).code, 'CONFIRM_REQUIRED');
  const running = confirmedState();
  assert.equal(canStart(running, { cwd: '/tmp/demo', now: NOW }).code, 'BUSY');
  const leased = acquireLease(running, { ownerId: 'host', now: at(), ttlMs: 60000 }).state;
  assert.equal(canStart(leased, { cwd: '/tmp/demo', now: NOW, leaseToken: leased.lock.token }).code, 'REENTRANT');
  assert.equal(canStart(leased, { cwd: '/other', now: NOW }).code, 'CWD_MISMATCH');
  assert.match(summarize(running), /swe-light/);
  assert.match(summarize(running), /round 1\/32/);
  assert.match(summarize(running), /open issues: 0/);
});

test('state exposes the bounded schema fields host relies on', () => {
  const state = confirmedState();
  for (const key of ['schemaVersion', 'runId', 'rootSessionId', 'cwd', 'mode', 'route', 'status',
    'revision', 'createdAt', 'updatedAt', 'expiresAt', 'lastProgressAt', 'lock', 'spec',
    'interview', 'ledger', 'plan', 'rounds', 'gate', 'audit', 'questions', 'evidence',
    'trace', 'traceSeq', 'failure', 'succession', 'stats', 'policy']) {
    assert.ok(key in state, `missing state.${key}`);
  }
  assert.ok(STATUSES.includes(state.status));
  assert.equal(state.policy.maxRounds, 32);
  assert.equal(state.rounds.max, 32);
  assert.equal(state.plan.tasks[0].budget.maxAttempts, 1);
  assert.equal(state.plan.tasks[0].promptIsComplete, false);
});
