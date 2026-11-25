import { asHostError, failure, oneLine, parseSwarmInput, splitWords, truncateText } from './host-format.js';
import { parseAlert } from './quota-watch.js';
import { formatStatus } from './host-tools.js';

import { coordinationCommand, coordinationHelp } from './coordination-commands.js';

const USAGE = [
  'Swarm — a shared board for a lead session and native teammates.',
  '',
  '/swarm init [title]                 Create the board for this root session',
  '/swarm add <name> [flags] <task>    Spawn a teammate (alias: start)',
  '  flags: --role worker|monitor  --channel <name>  --wake mentions|anything',
  '         --worktree  --model <provider/model>  --fallback <provider/model>  -- <literal task>',
  '/swarm merge <name>                 Fast-forward the lead checkout from a finished member',
  '/swarm status                       Board, member and plan summary',
  ...coordinationHelp,
  '/swarm quota [watch <CNY|USD> <amount> | off]   First-party DeepSeek wallet and optional low-balance alert (root)',
  '/swarm goal <text>                  Set/replace the plan goal',
  '/swarm post <text>                  Post as yourself',
  '/swarm pause|resume|kill <name>     Manage a teammate',
  '/swarm finish [name]                Kill one member, or all teammates',
  '/swarm done [note]                  Post the [done] end marker (does not kill anyone)',
  '/swarm channel create <name> [topic]  Create a channel (root)',
  '/swarm channel list                 List channels',
  '/swarm channel add|remove <name> <member>  Change membership',
  '/swarm channel archive <name>       Archive a channel',
  '/swarm view                         Bounded JSON for the right panel (root only)',
  '/swarm help                         This text',
].join('\n');

function readAddArgs(words) {
  const copy = [...words];
  const dart = copy.indexOf('--');
  let tail = [];
  if (dart !== -1) {
    tail = copy.splice(dart + 1);
    copy.splice(dart, 1);
  }
  const modelRoute = takeRoute(copy, '--model');
  const fallbackRoute = takeRoute(copy, '--fallback');
  const branchIndex = copy.indexOf('--worktree');
  if (branchIndex !== -1) copy.splice(branchIndex, 1);
  const role = take(copy, '--role');
  const channel = take(copy, '--channel');
  const wakeMode = take(copy, '--wake');
  const name = copy.shift();
  const rest = [...copy, ...tail].join(' ').trim();
  return { name, prompt: rest, role, channel, wakeMode, modelRoute, fallbackRoute, workspaceMode: branchIndex === -1 ? undefined : 'branch' };
}

function takeRoute(words, flag) {
  if (!words.includes(flag)) return undefined;
  const token = take(words, flag);
  const match = /^([^/\s]+)\/(\S+)$/.exec(token ?? '');
  if (!match || token.startsWith('--') || words.includes(flag)) {
    throw failure('INVALID_ARGUMENT', `${flag} requires one provider/model`);
  }
  return { provider: match[1], model: match[2] };
}

function take(words, flag) {
  const index = words.indexOf(flag);
  if (index === -1) return undefined;
  const value = words[index + 1];
  words.splice(index, value === undefined ? 1 : 2);
  return value;
}

function commandError(prefix, error) {
  const hostError = asHostError(error);
  const detail = hostError.details?.manual || hostError.details?.worktree ? ` ${truncateText(JSON.stringify(hostError.details), 2200)}` : '';
  return { kind: 'error', text: `${prefix}: ${hostError.message}${detail}` };
}

function parseCommand(rawInput) {
  const words = parseSwarmInput(rawInput);
  const verb = (words.shift() ?? 'help').toLowerCase();
  return { verb, words };
}

export function registerSwarmCommands(host) {
  host.ctx.commands.register({
    definitionId: '@local/dk-dsh-swarm.commands',
    name: 'swarm',
    description: 'Create and coordinate a Swarm: board, native teammates, posts and a read-only JSON view.',
    input: { hint: 'init [title] | add <name> <task> | status | goal <text> | post <text> | view' },
    async handler(invocation) {
      const { agent, rawInput, signal } = invocation;
      try {
        signal?.throwIfAborted?.();
        const { verb, words } = parseCommand(rawInput);
        if (verb === 'help' || verb === '' || verb === '-h' || verb === '--help') {
          return { kind: 'success', text: USAGE };
        }

        if (verb === 'init') {
          const entry = host.state.resolve(agent);
          if (entry && !entry.isRoot) throw failure('FORBIDDEN', 'only a root session can create a swarm');
          const rootId = host.ctx.subagents.rootOf(agent)?.id ?? agent.id;
          if (host.state.board(rootId)) throw failure('EXISTS', 'this root already has a swarm board');
          const title = words.join(' ').trim() || 'Swarm';
          const board = await host.state.create(agent, title);
          await host.activateRoot(agent);
          return {
            kind: 'success',
            text: `Swarm "${board.title}" created. Add a teammate with /swarm add <name> <task>.`,
          };
        }

        let entry = host.state.resolve(agent);
        if (!entry) {
          throw failure('NOT_MEMBER', 'no swarm here; run /swarm init on a root session first');
        }

        const coordination = await coordinationCommand(host, invocation, verb, words);
        if (coordination) return coordination;
        switch (verb) {
          case 'status': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can read /swarm status; members use read_board');
            const view = host.view(entry.rootId, { messageLimit: 8, textLimit: 240 });
            if (!view) throw failure('NOT_MEMBER', 'no swarm board');
            return { kind: 'success', text: formatStatus(view) };
          }
          case 'view': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can open /swarm view');
            signal?.throwIfAborted?.();
            const packet = host.view(entry.rootId);
            return { kind: 'success', text: JSON.stringify(packet) };
          }
          case 'add':
          case 'start': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can add teammates');
            const { name, prompt, role, channel, ...options } = readAddArgs(words);
            if (!name) throw failure('INVALID_ARGUMENT', 'usage: /swarm add <name> [flags] <task>');
            if (!prompt) throw failure('INVALID_ARGUMENT', 'a task prompt is required');
            if (role !== undefined && !['worker', 'monitor'].includes(role)) {
              throw failure('INVALID_ARGUMENT', 'role must be worker or monitor');
            }
            const added = await host.addMember({
              rootAgent: agent,
              name,
              prompt,
              role: role ?? 'worker',
              channels: channel ? [channel] : undefined,
              ...options,
              signal,
            });
            return {
              kind: 'success',
              text: `Added ${added.member.name} (${added.member.role}). Workspace: ${added.member.worktreePath ?? 'shared with the lead'}.`,
            };
          }
          case 'quota': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the root can read or monitor its account balance');
            if (!words.length) {
              const advisory = await host.quotaAdvisory({ signal });
              return { kind: 'success', text: JSON.stringify({ watch: entry.board.quotaWatch ?? null, ...advisory }) };
            }
            let watch;
            if (words[0] === 'off' && words.length === 1) watch = null;
            else if (words[0] === 'watch' && words.length === 3) watch = parseAlert(words[1], words[2]);
            else throw failure('INVALID_ARGUMENT', 'usage: /swarm quota [watch CNY|USD <amount> | off]');
            if (watch) {
              const report = await host.quotaAdvisory({ signal });
              if (!report?.supported || !report.signedIn || !report.balances?.some(x => x.currency === watch.currency && x.wallet === 'recharge')) {
                throw failure('BALANCE_UNAVAILABLE', report?.reason ?? `no ${watch.currency} recharge wallet reported`);
              }
            }
            const out = await host.state.act(entry.rootId, agent.id, { type: 'setQuotaWatch', watch });
            if (!out.result?.ok) throw failure(out.result.code, out.result.message);
            host.walletAlerts.alerted.delete(entry.rootId);
            return { kind: 'success', text: watch ? `Alert enabled for DeepSeek recharge wallet at or below ${watch.threshold} ${watch.currency}.` : 'Balance alerts off.' };
          }
          case 'merge': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can merge a teammate');
            if (words.length !== 1) throw failure('INVALID_ARGUMENT', 'usage: /swarm merge <name>');
            const delivery = await host.mergeMember(agent, words[0], signal);
            return { kind: 'success', text: `Delivered ${words[0]}: ${JSON.stringify(delivery)}. Checkout and branch retained.` };
          }
          case 'goal': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can set the goal');
            const goal = words.join(' ').trim();
            if (!goal) throw failure('INVALID_ARGUMENT', 'goal text is required');
            const out = await host.state.act(entry.rootId, agent.id, { type: 'setGoal', goal });
            if (!out.result?.ok) throw failure(out.result?.code, out.result?.message);
            return { kind: 'success', text: `Goal set: ${oneLine(goal, 200)}` };
          }
          case 'post': {
            signal?.throwIfAborted?.();
            const copy = [...words];
            const channel = take(copy, '--channel');
            const text = copy.join(' ').trim();
            if (!text) throw failure('INVALID_ARGUMENT', 'post text is required');
            const result = await host.post(entry.rootId, agent.id, text, channel);
            if (!result.ok) throw failure(result.code, result.message);
            return { kind: 'success', text: `Posted as seq ${result.seq}.` };
          }
          case 'pause':
          case 'resume':
          case 'kill': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can manage teammates');
            const target = words[0];
            if (!target) throw failure('INVALID_ARGUMENT', `usage: /swarm ${verb} <name>`);
            const member =
              verb === 'kill'
                ? await host.killMember(entry.rootId, target)
                : verb === 'pause'
                  ? await host.pauseMember(entry.rootId, target)
                  : await host.resumeMember(entry.rootId, target);
            return { kind: 'success', text: `${member.name}: ${member.status}` };
          }
          case 'finish': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can finish the swarm');
            const target = words[0];
            if (target) {
              const member = await host.killMember(entry.rootId, target);
              return { kind: 'success', text: `${member.name}: ${member.status}` };
            }
            const outcome = await host.finish(entry.rootId);
            const { killed, failed } = outcome;
            const cancelled = outcome.cancelled
              ? ` Cancelled ${outcome.cancelled} in-flight add${outcome.cancelled === 1 ? '' : 's'}.`
              : '';
            if (failed.length) {
              return {
                kind: 'error',
                text:
                  `Swarm finish was partial. Killed: ${killed.length ? killed.join(', ') : 'none'}. ` +
                  `Still live: ${failed.join('; ')}. Retry /swarm finish.${cancelled}`,
              };
            }
            return {
              kind: 'success',
              text:
                (killed.length
                  ? `Swarm finished. Killed: ${killed.join(', ')}. The board remains readable with /swarm view.`
                  : 'Swarm finished. There were no live teammates.') + cancelled,
            };
          }
          case 'done': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can mark the swarm done');
            const note = words
              .join(' ')
              .trim()
              .replaceAll('@', 'at ');
            const text = note ? `[done] ${note}` : '[done]';
            const result = await host.post(entry.rootId, agent.id, text, 'main');
            if (!result.ok) throw failure(result.code, result.message);
            return {
              kind: 'success',
              text: `Posted the [done] marker as seq ${result.seq} in #main. Teammates see it on their next read; nothing was killed.`,
            };
          }
          case 'channel': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can manage channels');
            const sub = (words.shift() ?? 'list').toLowerCase();
            if (sub === 'list') {
              const list = await host.listChannels(entry.rootId);
              const lines = list.map((channel) => {
                const state = channel.archived ? 'archived' : 'active';
                const subscribers = Array.isArray(channel.subscribers) ? channel.subscribers.length : 0;
                return `- #${channel.name} (${state}, ${subscribers} member${subscribers === 1 ? '' : 's'})${channel.topic ? `: ${channel.topic}` : ''}`;
              });
              return { kind: 'success', text: lines.length ? lines.join('\n') : 'No channels.' };
            }
            if (sub === 'create') {
              const name = words.shift();
              if (!name) throw failure('INVALID_ARGUMENT', 'usage: /swarm channel create <name> [topic]');
              const topic = words.join(' ').trim();
              const result = await host.createChannel(entry.rootId, name, topic || undefined);
              return { kind: 'success', text: `Created #${result.channel.name}.` };
            }
            if (sub === 'archive') {
              const name = words.shift();
              if (!name) throw failure('INVALID_ARGUMENT', 'usage: /swarm channel archive <name>');
              const result = await host.archiveChannel(entry.rootId, name);
              return { kind: 'success', text: `Archived #${result.channel.name}.` };
            }
            if (sub === 'add' || sub === 'subscribe' || sub === 'remove' || sub === 'unsubscribe') {
              const name = words.shift();
              const member = words.shift();
              if (!name || !member) {
                throw failure('INVALID_ARGUMENT', `usage: /swarm channel ${sub} <channel> <member>`);
              }
              const result =
                sub === 'add' || sub === 'subscribe'
                  ? await host.subscribeChannel(entry.rootId, name, member)
                  : await host.unsubscribeChannel(entry.rootId, name, member);
              return {
                kind: 'success',
                text: `${sub.startsWith('unsub') || sub === 'remove' ? 'Removed' : 'Added'} ${member} ${sub.startsWith('unsub') || sub === 'remove' ? 'from' : 'to'} #${result.channel.name}.`,
              };
            }
            return { kind: 'error', text: `Unknown channel action "${sub}".\n\n${USAGE}` };
          }
          case 'reconcile': {
            if (!entry.isRoot) throw failure('FORBIDDEN', 'only the swarm root can reconcile');
            const live = (host.ctx.agents?.list?.() ?? []).map((agentValue) => agentValue.id);
            await host.state.act(entry.rootId, agent.id, { type: 'reconcile', liveSessionIds: live });
            return { kind: 'success', text: 'Reconciled the board with live sessions.' };
          }
          default:
            return { kind: 'error', text: `Unknown /swarm command "${verb}".\n\n${USAGE}` };
        }
      } catch (error) {
        return commandError('/swarm', error);
      }
    },
  });
}

// Kept for tests that want to inspect quoted prompt parsing without a context.
export { USAGE as SWARM_USAGE, readAddArgs, truncateText, splitWords };
