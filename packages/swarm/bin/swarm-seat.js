#!/usr/bin/env node
import { enqueueMailbox, readMailbox, readMailboxAck } from '../src/external-bridge.js';

const usage = `Usage: swarm-seat <absolute-seat-dir> read
       swarm-seat <absolute-seat-dir> post <text> [channel] [--id <uuid-v4>]
       swarm-seat <absolute-seat-dir> submit <taskId> (<version> <path> | --path <path> | --commit <sha>) [--after <seq>] [--id <uuid-v4>]
       swarm-seat <absolute-seat-dir> ack <request-uuid>

Requires an authorized seat mount or a restricted login on the mailbox host.
Queueing is not acceptance; sync at the Host, then check the receipt.\n`;
async function run(seat, op, args) {
  if (op === 'read' && !args.length) return readMailbox(seat);
  if (op === 'ack' && args.length === 1) return readMailboxAck(seat, args[0]);
  let requestId;
  if (['post', 'submit'].includes(op) && args.length >= 3 && args.at(-2) === '--id') {
    requestId = args.at(-1);
    args = args.slice(0, -2);
  }
  if (op === 'post' && (args.length === 1 || args.length === 2)) {
    return enqueueMailbox(seat, { op, text: args[0], ...(args.length === 2 && { channel: args[1] }) }, requestId);
  }
  if (op === 'submit') {
    let after;
    if (args.length === 5 && args[3] === '--after' && /^\d+$/.test(args[4])) {
      after = Number(args[4]);
      args = args.slice(0, 3);
    }
    if (args.length === 3) {
      const [taskId, flag, value] = args;
      const refs = flag === '--path' ? {artifactPath:value} : flag === '--commit' ? {artifactCommit:value} :
        {artifactVersion:flag, artifactPath:value};
      return enqueueMailbox(seat, { op, taskId, ...refs, ...(after !== undefined && {after}) }, requestId);
    }
  }
  throw new Error(usage.trimEnd());
}
const [seat, op, ...args] = process.argv.slice(2);
if (seat === '--help') process.stdout.write(usage);
else {
  try { process.stdout.write(JSON.stringify(await run(seat, op, args)) + '\n'); }
  catch (e) { process.stderr.write(`${e.code ?? e.message}\n`); process.exitCode = 1; }
}
