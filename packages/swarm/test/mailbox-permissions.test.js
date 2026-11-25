import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createMailbox, readMailboxAck, syncMailbox } from '../src/external-bridge.js';

const posix = typeof process.getuid === 'function';
const cli = fileURLToPath(new URL('../bin/swarm-seat.js', import.meta.url));
const exec = promisify(execFile);

// Exercise the real file and process boundaries without requiring sudo or a
// second account. UID equivalence is NOT an isolation test; assert the group
// and other bits used by the separately provisioned per-seat group instead.
test('strict umask: request, snapshot and ack are private-group readable, never world-readable', { skip: !posix }, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-permissions-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const seat = await createMailbox(base);
  const inbox = path.join(seat, 'inbox');
  await chmod(seat, 0o2750);
  await chmod(inbox, 0o2770);
  const mask = process.umask(0o077); // Inherited by the independent CLI.
  try {
    const group = (await stat(seat)).gid;
    async function checkPublished(file) {
      const st = await stat(file);
      assert.equal(st.gid, group, path.basename(file) + ': inherit the seat group');
      assert.equal(st.mode & 0o777, 0o640, path.basename(file) + ': owner writes, group reads, no access for others');
    }
    const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, seat, ...args])).stdout);
    const { id } = await run('post', 'cross-process reply');
    await checkPublished(path.join(inbox, id + '.json'));
    const view = { assigned: 'task-1' };
    await syncMailbox(seat, { snapshot: () => view, consume: () => ({ ok: true, seq: 7 }) });
    await checkPublished(path.join(seat, 'view.json'));
    await checkPublished(path.join(seat, 'acks.json'));
    assert.deepEqual(await run('read'), view);
    const ack = await run('ack', id);
    assert.equal(ack.ok, true);
    assert.equal(ack.seq, 7);
    assert.equal((await stat(base)).mode & 0o777, 0o700);
    assert.equal((await stat(seat)).mode & 0o7777, 0o2750);
    assert.equal((await stat(inbox)).mode & 0o7777, 0o2770);
    assert.equal(process.umask(), 0o077, 'the bridge did not change the process-wide umask');
  } finally { process.umask(mask); }
});

test('a failure to unlink after the receipt is reported and can be retried without a second consume', {
  skip: !posix || process.getuid() === 0 ? 'requires unprivileged POSIX mode enforcement' : false,
}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-unlink-denied-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const seat = await createMailbox(base), inbox = path.join(seat, 'inbox');
  const id = randomUUID(), file = path.join(inbox, id + '.json');
  await writeFile(file, JSON.stringify({ op: 'post', text: 'once' }));
  let calls = 0;
  const sync = () => syncMailbox(seat, { snapshot: () => ({}), consume: () => ({ ok: true, seq: ++calls }) });
  await chmod(inbox, 0o500); // Can read the request but cannot remove its directory entry.
  try {
    await assert.rejects(sync, { code: 'EACCES' });
    assert.equal((await stat(file)).isFile(), true);
    assert.equal((await readMailboxAck(seat, id)).ok, true);
  } finally { await chmod(inbox, 0o700); }
  assert.deepEqual(await sync(), { processed: 1, rejected: 0 });
  assert.equal(calls, 1);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('an unreadable request reports a transport failure and remains unacknowledged for retry', {
  skip: !posix || process.getuid() === 0 ? 'requires unprivileged POSIX mode enforcement' : false,
}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-denied-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const seat = await createMailbox(base);
  const id = randomUUID(), file = path.join(seat, 'inbox', id + '.json');
  await writeFile(file, JSON.stringify({ op: 'post', text: 'retry later' }), { mode: 0o000 });
  await assert.rejects(syncMailbox(seat, { snapshot: () => ({}), consume: assert.fail }), { code: 'EACCES' });
  assert.equal((await stat(file)).isFile(), true);
  assert.deepEqual(await readMailboxAck(seat, id), { id, pending: true });
});
