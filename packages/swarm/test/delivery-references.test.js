// Public command/tool regressions: one in-memory board; no checkout, Git or artifact reader.
import assert from 'node:assert/strict';
import test from 'node:test';
import { newBoard, transition } from '../src/board.js';
import { coordinationCommand } from '../src/coordination-commands.js';
import { registerSwarmTools } from '../src/host-tools.js';

function setup() {
  const lead = { id: 'private-lead-id' }, owner = { id: 'private-owner-id' };
  let board = newBoard(lead.id, 'Reference checks', { coordinator: lead.id });
  const act = (_rootId, actorId, action) => {
    const out = transition(board, actorId, action);
    board = out.state;
    return out;
  };
  assert.ok(act(lead.id, lead.id, {type:'add', member:{sessionId:owner.id, name:'writer', role:'worker'}}).result.ok);
  assert.ok(act(lead.id, lead.id, {type:'assignDelivery', owner:owner.id, taskId:'notes', deliverable:'Report', criterion:'Includes references'}).result.ok);
  let tool;
  const host = {
    ctx:{tools:{register(def) { if (def.name === 'swarm_delivery') tool = def; }}},
    ensureMember:agent => ({board, rootId:lead.id, self:board.members[agent.id], isRoot:agent.id === lead.id}),
    state:{act, rootAgent:() => null}, steerRoot:async () => false,
  };
  registerSwarmTools(host);
  return {
    lead, owner, tool,
    submit:async words => JSON.parse((await coordinationCommand(host, {agent:owner}, 'submit', ['notes', ...words])).text).delivery,
    call:(agent, action, args) => tool.execute({action, taskId:'notes', ...args}, {agent}),
  };
}

test('slash submit accepts a path or commit independently without changing the legacy pair', async () => {
  const {submit} = setup();
  assert.deepEqual((await submit(['--path', 'build/notes v2.md'])).submission, {seq:1, refKind:'path', artifactPath:'build/notes v2.md'});
  assert.deepEqual((await submit(['--commit', 'af13490'])).submission, {seq:2, refKind:'commit', artifactCommit:'af13490'});
  assert.deepEqual((await submit(['v2', 'notes.md'])).submission, {seq:3, artifactVersion:'v2', artifactPath:'notes.md'});
});

test('review tool refuses each mismatched reference instead of silently accepting it', async () => {
  const {lead, owner, call} = setup();
  const refs = {artifactPath:'notes.md', artifactVersion:'v1'};
  assert.ok((await call(owner, 'submit', refs)).ok);
  const review = {submittedSeq:1, decision:'accepted', checkPassed:true, evidence:'Independently read the references.'};
  for (const stale of [{artifactPath:'wrong.md'}, {artifactVersion:'v0'}, {artifactCommit:'badcafe'}]) {
    const out = await call(lead, 'review', {...review, ...stale});
    assert.equal(out.code, 'INVALID_STATE', `review discarded constraint ${JSON.stringify(stale)}`);
  }
  assert.equal((await call(lead, 'review', {...review, ...refs})).delivery.status, 'accepted');
});

test('tool exposes commit submissions and redacts reviewer IDs in historical return details', async () => {
  const {lead, owner, call, tool} = setup();
  assert.equal(tool.parameters.properties.artifactCommit?.type, 'string');
  assert.ok((await call(owner, 'submit', {artifactCommit:'deadbeef'})).ok);
  const review = {submittedSeq:1, decision:'returned', checkPassed:false, evidence:'No bibliography.', artifactCommit:'deadbeef'};
  const returned = (await call(lead, 'review', review)).delivery.review;
  assert.equal(returned.reviewer, 'coordinator'); // Board display name, never the host session ID.
  assert.equal((await call(owner, 'submit', {artifactPath:'notes v2.md'})).delivery.review, null);
  const updated = (await call(owner, 'list', {})).delivery;
  assert.deepEqual(updated.lastReturn, returned);
  assert.equal(updated.lastReturn.submittedSeq, 1);
  assert.equal(updated.submission.seq, 2);
});
