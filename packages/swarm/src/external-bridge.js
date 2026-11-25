// POSIX file transport, never an authority over the board. The Host supplies a
// seat-bound, durably idempotent consume() and a role-filtered snapshot().
// Only inbox *entries* may be controlled by a remote principal. Administrators
// grant a distinct principal read/traverse of ONE seat and write/traverse of its
// inbox, not write access to the seat/ancestors. Shared host UIDs are trusted.
import { constants as F, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isValidChannelName } from './channels.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VIEW_BYTES = 4 * 1024 * 1024, REQUEST_BYTES = 64 * 1024, ACK_BYTES = 64 * 1024;
const BATCH = 32, SCAN = 256, ACK_LIMIT = 256;
const syncing = new Set();
const bad = code => Object.assign(new Error(code), { code });
const invalid = () => { throw bad('INVALID_REQUEST'); };
const validId = id => typeof id === 'string' && id.length === 36 && UUID.test(id);
const validSeatName = name => name.startsWith('seat-') && validId(name.slice(5));

function absolute(dir) {
  if (typeof process.getuid !== 'function' || !F.O_NOFOLLOW) throw bad('POSIX_REQUIRED');
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.resolve(dir) !== dir || dir === '/') throw bad('UNSAFE_PATH');
  return dir;
}

// Reject mutable ancestors (root-owned sticky /tmp is safe for an owned child)
// and links, not just a final-component realpath check. POSIX ACLs/mounts must
// preserve these same boundaries. Never chmod/chown pre-existing directories.
async function directoryChain(dir, host = false) {
  absolute(dir);
  const uid = process.getuid();
  let here = '/';
  for (const part of dir.slice(1).split('/')) {
    here = path.join(here, part);
    const stat = await fs.lstat(here);
    if (!stat.isDirectory() || (host && stat.uid !== uid && stat.uid !== 0)) throw bad('UNSAFE_PATH');
    if ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000) && here !== dir)) throw bad('UNSAFE_PATH');
  }
}
async function privateBase(base) {
  await directoryChain(base, true);
  const stat = await fs.lstat(base);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw bad('PRIVATE_BASE_REQUIRED');
}

export async function createMailbox(base) {
  await privateBase(base);
  // Do not adopt a project, home directory, or arbitrary non-empty directory.
  const entries = await fs.opendir(base);
  for await (const e of entries) {
    if (!validSeatName(e.name) || !e.isDirectory()) throw bad('DEDICATED_BASE_REQUIRED');
  }
  const seat = path.join(base, 'seat-' + randomUUID());
  await fs.mkdir(seat, { mode: 0o700 });
  await fs.mkdir(path.join(seat, 'inbox'), { mode: 0o700 });
  return seat; // No recursive cleanup if enrollment is cancelled/rolled back.
}

async function checkSeat(seat, host) {
  absolute(seat);
  if (host) {
    if (!validSeatName(path.basename(seat))) throw bad('UNSAFE_SEAT');
    await privateBase(path.dirname(seat));
  } else {
    // A client's mountpoint need not have the same name as the Host directory.
    await directoryChain(seat);
  }
  const box = await fs.lstat(seat);
  if (!box.isDirectory() || (box.mode & 0o022) || (host && box.uid !== process.getuid())) throw bad('UNSAFE_SEAT');
  const inbox = await fs.lstat(path.join(seat, 'inbox'));
  // An inbox may be group-writable; it cannot replace its own directory entry.
  if (!inbox.isDirectory() || (inbox.mode & 0o002) || (host && inbox.uid !== process.getuid())) throw bad('UNSAFE_SEAT');
}

async function readJson(file, max) {
  // lstat avoids devices/FIFOs in normal operation. O_NOFOLLOW + nonblocking
  // open + fstat close the entry-swap race. Never trust size or readFile() a
  // growing file; bound bytes read from the already-opened descriptor.
  const acceptable = stat => stat.isFile() && stat.nlink === 1 && stat.size <= max;
  if (!acceptable(await fs.lstat(file))) throw bad('INVALID_FILE');
  const handle = await fs.open(file, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!acceptable(st)) throw bad('INVALID_FILE');
    const bytes = Buffer.allocUnsafe(st.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const { bytesRead } = await handle.read(bytes, n, bytes.length - n, null);
      if (!bytesRead) break;
      n += bytesRead;
    }
    if (n !== st.size) throw bad('INVALID_FILE');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n))); }
    catch { throw bad('INVALID_JSON'); }
  } finally { await handle.close(); }
}

async function atomicJson(file, data, max) {
  const json = JSON.stringify(data);
  if (typeof json !== 'string' || Buffer.byteLength(json) > max) throw bad('OUTPUT_LIMIT');
  const temp = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
  const handle = await fs.open(temp, 'wx', 0o644);
  try {
    try { await handle.writeFile(json); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file); // Never follow/open/truncate the destination.
  } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
}

function requestFor(id, data) {
  if (!validId(id) || !data || typeof data !== 'object' || Array.isArray(data)) invalid();
  const keys = Object.keys(data);
  const only = allowed => keys.every(k => allowed.includes(k));
  const string = (s, max) => typeof s === 'string' && s.trim().length && Buffer.byteLength(s) <= max;
  if (data.op === 'post' && only(['op', 'text', 'channel']) && string(data.text, 8192)) {
    if (data.channel === undefined) return { id, op: 'post', text: data.text };
    if (data.channel === 'main' || isValidChannelName(data.channel)) return { id, op: 'post', text: data.text, channel: data.channel };
  }
  if (data.op === 'submit' && only(['op', 'taskId', 'artifactVersion', 'artifactPath'])) {
    const { taskId, artifactVersion, artifactPath } = data;
    if (string(taskId, 128) && string(artifactVersion, 256) && string(artifactPath, 1024) &&
        !/[\x00-\x1f\x7f]/.test(taskId + artifactVersion + artifactPath) && !/^[A-Za-z]:/.test(artifactPath) &&
        !artifactPath.includes('\\') && artifactPath.split('/').every(p => p !== '' && p !== '.' && p !== '..')) {
      return { id, op: 'submit', taskId, artifactVersion, artifactPath }; // Reference only; never opened.
    }
  }
  invalid();
}

async function receipts(seat) {
  try { return await readJson(path.join(seat, 'acks.json'), ACK_BYTES); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return []; }
}
function ackFor(id, result) {
  if (typeof result?.ok !== 'boolean') throw bad('INVALID_CONSUMER_RESULT');
  const ack = { id, ok: result.ok };
  if (typeof result.code === 'string' && /^[A-Za-z_0-9-]{1,64}$/.test(result.code)) ack.code = result.code;
  if (Number.isSafeInteger(result.seq) && result.seq >= 0) ack.seq = result.seq;
  return ack; // Never leak raw errors, sessions, paths or backend details.
}

// CLI-facing operations use no Host services, network, profiles or processes.
export async function readMailbox(seat) {
  await checkSeat(seat, false);
  return readJson(path.join(seat, 'view.json'), VIEW_BYTES);
}
export async function enqueueMailbox(seat, data) {
  await checkSeat(seat, false);
  const id = randomUUID();
  requestFor(id, data);
  await atomicJson(path.join(seat, 'inbox', id + '.json'), data, REQUEST_BYTES);
  return { id, queued: true };
}
export async function readMailboxAck(seat, id) {
  if (!validId(id)) invalid();
  await checkSeat(seat, false);
  return (await receipts(seat)).find(a => a.id === id) ?? { id, pending: true };
}

export async function syncMailbox(seat, { snapshot, consume }) {
  if (syncing.has(seat)) throw bad('MAILBOX_BUSY');
  syncing.add(seat);
  try {
    await checkSeat(seat, true);
    let acks = await receipts(seat), processed = 0, rejected = 0, scanned = 0;
    const inbox = path.join(seat, 'inbox');
    const dir = await fs.opendir(inbox);
    for await (const entry of dir) {
      if (++scanned > SCAN || processed + rejected >= BATCH) break;
      const id = entry.name.slice(0, -5);
      if (!entry.name.endsWith('.json') || !validId(id)) continue;
      const file = path.join(inbox, entry.name);
      let ack = acks.find(a => a.id === id);
      if (!ack) {
        let request;
        try { request = requestFor(id, await readJson(file, REQUEST_BYTES)); }
        catch (e) {
          if (e.code === 'ENOENT') continue;
          if (!['ELOOP', 'INVALID_FILE', 'INVALID_JSON', 'INVALID_REQUEST', 'EACCES'].includes(e.code)) throw e;
          ack = { id, ok: false, code: 'INVALID_REQUEST' };
        }
        if (request) ack = ackFor(id, await consume(request));
        acks = [...acks.slice(1 - ACK_LIMIT), ack];
        await atomicJson(path.join(seat, 'acks.json'), acks, ACK_BYTES);
      }
      // An unexpected directory is not a file to be recursively deleted.
      await fs.unlink(file).catch(e => { if (!['ENOENT', 'EISDIR', 'EPERM'].includes(e.code)) throw e; });
      if (ack.ok) processed++; else rejected++;
    }
    await atomicJson(path.join(seat, 'view.json'), await snapshot(), VIEW_BYTES);
    return { processed, rejected };
  } finally { syncing.delete(seat); }
}
