// Native add contract: a hold is not a registered member or an assigned delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as boardApi from '../src/board.js';
import { BoardState } from '../src/host-state.js';
import { SwarmHost } from '../src/host-runtime.js';
import { registerSwarmCommands } from '../src/host-commands.js';
import { registerSwarmTools } from '../src/host-tools.js';
const { newBoard, transition } = boardApi;

const contract = { taskId: 'map', deliverable: 'Station map', criterion: 'Labels include every stop' };
const member = { name: 'artist', sessionId: 'artist-session' };
const reserve = { type: 'reserveJoin', member, contract };
const submit = { type: 'submitDelivery', taskId: 'map', artifactPath: 'map.svg', artifactVersion: 'v1' };
const act = (board, action, who = 'lead') => transition(board, who, action);
const initial = () => newBoard('lead', 'Transit', { coordinator: 'lead' });

test('only the lead can reserve a native contract; assignment and ownership start together at join', () => {
  const attempt = act(initial(), reserve);
  assert.equal(attempt.result.ok, true);
  const { state: held, result: { reservationId } } = attempt;
  assert.deepEqual(held.deliveries, []);
  assert.equal(act(held, submit, member.sessionId).result.code, 'NOT_MEMBER');
  const commit = { type: 'commitJoin', reservationId };
  assert.equal(act(held, commit, member.sessionId).result.code, 'FORBIDDEN');
  const { state: joined, result } = act(held, commit);
  assert.equal(result.ok, true);
  assert.equal(joined.members[member.sessionId].name, 'artist');
  assert.deepEqual(joined.deliveries, [{ ...contract, owner: member.sessionId, status: 'assigned', updatedAt: joined.clock, review: null, submission: null }]);
  // A conflicting/corrupt prior record cannot publish a half-joined member.
  const inconsistent = structuredClone(held);
  inconsistent.deliveries.push(joined.deliveries[0]);
  const conflict = act(inconsistent, commit);
  assert.equal(conflict.result.code, 'INVALID_STATE');
  assert.equal(conflict.state, inconsistent);
  assert.equal(conflict.state.members[member.sessionId], undefined);
  assert.equal(act(joined, submit, member.sessionId).result.delivery.status, 'submitted');
  assert.equal(act(joined, { ...reserve, member: { sessionId: 'peer', name: 'peer' }, contract: { ...contract, taskId: 'next' } }, member.sessionId).result.code, 'FORBIDDEN');
});

test('contract reservations protect their ID and capacity against both assignments and other joins until revoked', () => {
  const owner = { sessionId: 'peer', name: 'peer' };
  const assign = { type: 'assignDelivery', owner: owner.sessionId, ...contract };
  const other = { ...reserve, member: { sessionId: 'other', name: 'other' } };
  let board = act(initial(), { type: 'add', member: owner }).state;
  // With 127 assigned, the pending join must own the last slot. Populate via public transitions.
  for (let i = 0; i < 127; ++i) {
    const assigned = act(board, { ...assign, taskId: `done-${i}` });
    assert.equal(assigned.result.ok, true);
    board = assigned.state;
  }
  const { state: held, result: { reservationId } } = act(board, reserve);
  for (const [action, code] of [[assign, 'INVALID_STATE'], [other, 'INVALID_STATE'],
    [{ ...assign, taskId: 'next' }, 'LIMIT'], [{ ...other, contract: { ...contract, taskId: 'next' } }, 'LIMIT']]) {
    const rejected = act(held, action);
    assert.equal(rejected.result.code, code);
    assert.equal(rejected.state, held);
  }
  const revoke = { type: 'failJoin', reservationId };
  assert.equal(act(held, revoke, member.sessionId).result.code, 'FORBIDDEN');
  const revoked = act(held, revoke).state;
  assert.equal(act(revoked, assign).result.ok, true, 'revocation frees ID and slot');
  assert.equal(act(held, { type: 'commitJoin', reservationId }).state.deliveries.length, 128);
});

async function nativeHarness() {
  const root = { id: 'lead' };
  const records = new Map();
  const store = { get: k => records.get(k), transact: async (k, fn) => {
    const { state, result } = fn(records.get(k));
    records.set(k, structuredClone(state));
    return result;
  } };
  const tools = {};
  let command;
  const ctx = {
    commands: { register: def => { command = def; } }, tools: { register: def => { tools[def.name] = def; } },
    subagents: { rootOf: () => root }, agents: { get: id => id === root.id ? root : null },
    workingDirectory: { ensure: async () => '/workspace', get: () => '/workspace' },
  };
  const state = new BoardState({ ctx, store, board: boardApi });
  await state.create(root, 'Transit', 'lead');
  const host = new SwarmHost({ ctx, store, state });
  registerSwarmCommands(host);
  registerSwarmTools(host);
  return { host, state, root, subagents: ctx.subagents, tools, run: rawInput => command.handler({ agent: root, rawInput }) };
}

test('native add freezes the criterion into the actual first prompt and notifies the registered owner only after commit', async () => {
  const { state, root, run, subagents } = await nativeHarness();
  const events = [];
  subagents.startActivation = async spec => {
    const prompt = spec.prompt[0].text;
    events.push('spawn');
    for (const phrase of [contract.taskId, contract.deliverable, contract.criterion, 'Draw --contract literally']) assert.ok(prompt.includes(phrase), phrase);
    assert.equal(state.member(root.id, spec.childId), null);
    assert.equal((await state.act(root.id, spec.childId, submit)).result.code, 'NOT_MEMBER');
    assert.equal(Object.values(state.board(root.id).reservations)[0].contract.taskId, contract.taskId);
    return { childId: spec.childId, result: Promise.resolve({ stopReason: 'completed' }) };
  };
  subagents.sendMessage = async (from, id, content) => {
    events.push('notice');
    assert.equal(from, root);
    assert.equal(id, state.board(root.id).deliveries[0].owner);
    assert.ok(content[0].text.includes('map'));
    assert.equal((await state.act(root.id, id, submit)).result.delivery.status, 'submitted');
  };
  const result = await run('add artist --contract map "Station map" "Labels include every stop" -- Draw --contract literally');
  assert.equal(result.kind, 'success', result.text);
  assert.deepEqual(events, ['spawn', 'notice']);
  assert.equal(state.board(root.id).deliveries[0].status, 'submitted');
});

test('invalid contracts never launch a child; spawn failure releases the ID; tool add and ordinary add coexist', async () => {
  const { state, root, tools, subagents, run } = await nativeHarness();
  let spawns = 0;
  subagents.startActivation = async spec => { spawns++; throw Error('offline'); };
  for (const flags of ['--contract map brief', '--contract map brief check extra', '--contract map brief check --contract another yes ok', '--contract map "" check', '--contract __proto__ brief check']) {
    assert.equal((await run(`add artist ${flags} -- draw`)).kind, 'error');
    assert.equal(spawns, 0, flags);
  }
  assert.equal((await run('add artist --contract map brief check -- draw')).kind, 'error');
  assert.equal(spawns, 1);
  assert.deepEqual(state.board(root.id).reservations, {});
  assert.deepEqual(state.board(root.id).deliveries, []);
  subagents.startActivation = async spec => ({ childId: spec.childId });
  assert.ok(tools.swarm.parameters.properties.contract);
  const added = await tools.swarm.execute({ action: 'add', name: 'artist', prompt: 'draw', contract }, { agent: root });
  assert.equal(added.ok, true, added.message); // advisory sendMessage missing; committed assignment survives
  assert.equal(added.notified, false);
  assert.equal(added.taskId, 'map');
  assert.match(added.message, /assignment is saved/);
  assert.equal(state.board(root.id).deliveries[0].taskId, 'map');
  assert.equal((await run('add helper -- draw --contract literally')).kind, 'success');
  assert.equal(state.board(root.id).deliveries.length, 1);
});

test('abort during activation cannot commit a contracted child even if its provider ignored the signal', async () => {
  const { state, root, host, subagents } = await nativeHarness();
  const abort = new AbortController();
  let disposed = false;
  subagents.startActivation = async ({ childId }) => {
    abort.abort(Error('cancel dispatch'));
    return { childId, dispose: async () => { disposed = true; } };
  };
  await assert.rejects(host.addMember({ rootAgent: root, name: 'artist', prompt: 'draw', contract, signal: abort.signal }), /cancel dispatch/);
  assert.equal(disposed, true);
  assert.deepEqual(state.board(root.id).reservations, {});
  assert.deepEqual(state.board(root.id).deliveries, []);
  assert.equal(state.memberByName(root.id, 'artist'), null);
});
