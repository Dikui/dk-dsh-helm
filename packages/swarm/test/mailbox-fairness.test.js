import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMailbox, enqueueMailbox, readMailboxAck, syncMailbox } from '../src/external-bridge.js';

// Regression (medium): a bounded sync must eventually visit the whole inbox,
// even when some entries cannot safely be unlinked. Use real POSIX directory ordering.
test('successive bounded syncs reach pending receipts beyond retained inbox entries', {
  skip: typeof process.getuid !== 'function' || !constants.O_NOFOLLOW,
}, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-fairness-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const seat = await createMailbox(base);
  const inbox = path.join(seat, 'inbox');
  const ids = Array.from({ length: 65 }, () => randomUUID());
  for (const id of ids) await mkdir(path.join(inbox, id + '.json'));
  const temporary = path.join(inbox, '.' + randomUUID() + '.tmp');
  await writeFile(temporary, 'writer still publishing');
  const queued = await enqueueMailbox(seat, { op: 'post', text: 'ready' });
  const received = [];
  for (let i = 0; i < 3; i++) {
    const { processed, rejected } = await syncMailbox(seat, {
      snapshot: () => ({}), consume: request => { received.push(request.id); return { ok: true }; },
    });
    assert.ok(processed + rejected <= 32);
  }
  const acks = await Promise.all(ids.map(id => readMailboxAck(seat, id)));
  assert.equal(acks.filter(ack => ack.code === 'INVALID_REQUEST').length, 65);
  assert.deepEqual(received, [queued.id]);
  assert.equal((await readMailboxAck(seat, queued.id)).ok, true);
  assert.equal(await readFile(temporary, 'utf8'), 'writer still publishing');
});
