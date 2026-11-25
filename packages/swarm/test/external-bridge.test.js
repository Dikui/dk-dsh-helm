import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMailbox, syncMailbox } from '../src/external-bridge.js';

const cli = fileURLToPath(new URL('../bin/swarm-seat.js', import.meta.url));
const exec = promisify(execFile);
async function command(seat, ...args) {
  const { stdout } = await exec(process.execPath, [cli, seat, ...args]);
  return JSON.parse(stdout);
}
async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-external-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, seat: await createMailbox(base) };
}

test('independent CLI reads its assigned view; queueing, consumption and receipt are distinct', async t => {
  const { base, seat } = await fixture(t);
  const peer = await createMailbox(base);
  const view = { posts: [], tasks: [{ id: 'task-1', assignee: 'sam' }] };
  const received = [];
  const sync = () => syncMailbox(seat, {
    snapshot: () => view,
    consume: request => { received.push(request); return { ok: true, seq: received.length }; },
  });
  await sync();
  assert.deepEqual(await command(seat, 'read'), view);
  await assert.rejects(command(peer, 'read'));
  const { id, queued } = await command(seat, 'post', 'hello from another process', 'main');
  assert.equal(queued, true);
  assert.deepEqual(await command(seat, 'ack', id), { id, pending: true });
  assert.equal(received.length, 0);
  assert.deepEqual(await sync(), { processed: 1, rejected: 0 });
  assert.deepEqual(received[0], { id, op: 'post', text: 'hello from another process', channel: 'main' });
  assert.deepEqual(await command(seat, 'ack', id), { id, ok: true, seq: 1 });
  assert.deepEqual(await command(peer, 'ack', id), { id, pending: true });
  const submit = await command(seat, 'submit', 'task-1', 'v1.2', 'out/result.md');
  await sync();
  assert.deepEqual(received[1], { id: submit.id, op: 'submit', taskId: 'task-1', artifactVersion: 'v1.2', artifactPath: 'out/result.md' });
});

test('Host sync rejects an unsafe inbox/base before observing input or publishing board data', async t => {
  const { base, seat } = await fixture(t);
  const inbox = path.join(seat, 'inbox');
  const sync = () => syncMailbox(seat, { snapshot: () => ({}), consume: assert.fail });
  assert.equal((await stat(seat)).mode & 0o777, 0o700);
  assert.equal((await stat(inbox)).mode & 0o777, 0o700);
  await chmod(inbox, 0o777);
  await assert.rejects(sync, { code: 'UNSAFE_SEAT' });
  await chmod(inbox, 0o770); // A dedicated per-seat group is supported.
  await sync();
  await chmod(base, 0o755);
  await assert.rejects(sync, { code: 'PRIVATE_BASE_REQUIRED' });
  await chmod(base, 0o700);
  await rename(inbox, path.join(seat, 'original'));
  await symlink(base, inbox);
  await assert.rejects(sync, { code: 'UNSAFE_SEAT' });
  await assert.rejects(command(seat, 'post', 'no write through links'));
  await assert.rejects(createMailbox(path.join(base, 'link-to-base')), { code: 'ENOENT' });
  await symlink(base, path.join(base, 'link-to-base'));
  await assert.rejects(createMailbox(path.join(base, 'link-to-base')), { code: 'UNSAFE_PATH' });
  await assert.rejects(createMailbox(base), { code: 'DEDICATED_BASE_REQUIRED' });
  await assert.rejects(createMailbox(base + '/..'), { code: 'UNSAFE_PATH' });
  const shared = path.join(seat, 'untrusted-parent'), mount = path.join(shared, 'mount');
  await mkdir(path.join(mount, 'inbox'), { recursive: true, mode: 0o700 });
  await chmod(shared, 0o777);
  await assert.rejects(command(mount, 'post', 'not through a mutable mount parent'), /UNSAFE_PATH/);
});

test('malformed input, special files and forged identity never reach the consumer or block a valid peer message', async t => {
  const { seat } = await fixture(t);
  const inbox = path.join(seat, 'inbox');
  const sentinel = path.join(seat, 'sentinel');
  const valid = JSON.stringify({ op: 'post', text: 'never follow this reference' });
  await writeFile(sentinel, valid);
  const badIds = [];
  const entry = () => { const id = randomUUID(); badIds.push(id); return path.join(inbox, id + '.json'); };
  await symlink(sentinel, entry());
  await link(sentinel, entry());
  await exec('mkfifo', [entry()]); // Would hang an unguarded FIFO open.
  await mkdir(entry()); // Never recursively delete an untrusted directory.
  await writeFile(entry(), Buffer.alloc(65 * 1024, 0x20));
  await writeFile(entry(), '{');
  await writeFile(entry(), JSON.stringify({ op: 'post', text: 'x', author: 'lead', root: 'another board' }));
  await writeFile(entry(), '{"op":"post","text":"x","__proto__":{"name":"lead"}}');
  await writeFile(entry(), JSON.stringify({ op: 'submit', taskId: 'a', artifactVersion: 'v', artifactPath: '../outside' }));
  const { id } = await command(seat, 'post', 'permitted');
  const results = [];
  const counts = await syncMailbox(seat, { snapshot: () => ({}), consume: m => { results.push(m.text); return { ok: false, code: 'PAUSED', privateInfo: 'redact me' }; } });
  assert.deepEqual(counts, { processed: 0, rejected: badIds.length + 1 });
  assert.deepEqual(results, ['permitted']);
  assert.equal(await readFile(sentinel, 'utf8'), valid);
  assert.deepEqual(await command(seat, 'ack', id), { id, ok: false, code: 'PAUSED' });
  for (const id of badIds) assert.deepEqual(await command(seat, 'ack', id), { id, ok: false, code: 'INVALID_REQUEST' });
  await assert.rejects(command(seat, 'ack', '../other/view'));
  await assert.rejects(command(seat, 'post', '界'.repeat(2731)));
  await assert.rejects(command(seat, 'submit', 'task', 'v1', '/absolute/path'));
});

test('after a committed consume throws, replay retains request identity and cannot double-apply an idempotent Host transaction', async t => {
  const { seat } = await fixture(t);
  const { id } = await command(seat, 'post', 'once');
  const receiptFile = path.join(seat, 'test-host-ledger');
  let crash = true, attempts = 0;
  const sync = () => syncMailbox(seat, {
    snapshot: () => ({ visible: true }),
    async consume(request) {
      // This fixture models a single atomic Host write containing both board
      // effects and receipts. After reopening it has no in-memory dedupe state.
      attempts++;
      let ledger;
      try { ledger = JSON.parse(await readFile(receiptFile, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; ledger = { posts: [], acks: {} }; }
      if (Object.hasOwn(ledger.acks, request.id)) return ledger.acks[request.id];
      ledger.posts.push(request.text);
      ledger.acks[request.id] = { ok: true, seq: ledger.posts.length };
      await writeFile(receiptFile + '.tmp', JSON.stringify(ledger));
      await rename(receiptFile + '.tmp', receiptFile);
      if (crash) { crash = false; throw Error('simulated loss after durable Host write'); }
      return ledger.acks[request.id];
    },
  });
  await assert.rejects(sync, /simulated loss/);
  assert.deepEqual(await command(seat, 'ack', id), { id, pending: true });
  await sync();
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(await readFile(receiptFile, 'utf8')).posts, ['once']);
  // Residual envelope after ACK but before unlink uses the cached ack.
  await writeFile(path.join(seat, 'inbox', id + '.json'), JSON.stringify({ op: 'post', text: 'changed' }));
  await sync();
  assert.equal(attempts, 2);
  assert.deepEqual(await command(seat, 'ack', id), { id, ok: true, seq: 1 });
});

test('only one sync per seat; work per call is bounded; failed or oversized view publication is not partial', async t => {
  const { seat } = await fixture(t);
  const inbox = path.join(seat, 'inbox');
  await Promise.all(Array.from({ length: 34 }, () => writeFile(path.join(inbox, randomUUID() + '.json'), '{"op":"post","text":"hi"}')));
  let release, started;
  const active = new Promise(resolve => { started = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const options = { snapshot: () => ({ small: true }), consume: async () => { started(); await pause; return { ok: true }; } };
  const first = syncMailbox(seat, options);
  await active;
  try { await assert.rejects(syncMailbox(seat, options), { code: 'MAILBOX_BUSY' }); } finally { release(); }
  assert.deepEqual(await first, { processed: 32, rejected: 0 });
  assert.equal((await readdir(inbox)).length, 2);
  await assert.rejects(syncMailbox(seat, { ...options, snapshot: () => 'a'.repeat(4 * 1024 * 1024) }), { code: 'OUTPUT_LIMIT' });
  assert.deepEqual(await command(seat, 'read'), { small: true });
});
