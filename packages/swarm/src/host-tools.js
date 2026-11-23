import { asHostError, byteLength, failure, isPlainObject, truncateText } from './host-format.js';

const OUTPUT = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  additionalProperties: true,
  required: ['ok'],
};

function json(value) {
  const text = JSON.stringify(value, null, 2);
  return [{ type: 'text', text: truncateText(text, 9000) }];
}

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function toolError(error) {
  const hostError = asHostError(error);
  return {
    ok: false,
    code: hostError.code,
    message: hostError.message,
    ...(hostError.details ? { details: hostError.details } : {}),
  };
}

function validatePublicPlan(plan) {
  if (!isPlainObject(plan)) throw failure('INVALID_ARGUMENT', 'plan must be a JSON object');
  if (plan.goal !== undefined && typeof plan.goal !== 'string' && !isPlainObject(plan.goal)) {
    throw failure('INVALID_ARGUMENT', 'plan.goal must be a string or {title,line}');
  }
  if (isPlainObject(plan.goal)) {
    for (const key of ['title', 'line']) {
      if (plan.goal[key] !== undefined && typeof plan.goal[key] !== 'string') {
        throw failure('INVALID_ARGUMENT', `plan.goal.${key} must be a string`);
      }
    }
  }
  for (const key of ['tasks', 'threads']) {
    const value = plan[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) && !isPlainObject(value)) {
      throw failure('INVALID_ARGUMENT', `plan.${key} must be an array or object`);
    }
    const items = Array.isArray(value) ? value : Object.values(value);
    for (const item of items) {
      if (typeof item !== 'string' && !isPlainObject(item)) {
        throw failure('INVALID_ARGUMENT', `plan.${key} entries must be strings or objects`);
      }
    }
  }
  let text;
  try {
    text = JSON.stringify(plan);
  } catch {
    throw failure('INVALID_ARGUMENT', 'plan is not JSON-serializable');
  }
  if (typeof text !== 'string') throw failure('INVALID_ARGUMENT', 'plan is not JSON-serializable');
  if (byteLength(text) > 60_000) throw failure('LIMIT', 'plan is too large');
  return plan;
}

function memberLine(member) {
  const role = member.role === 'coordinator' ? 'lead' : member.role;
  const unread = member.unread ? `, ${member.unread} unread` : '';
  return `- ${member.name} (${role}, ${member.status}${unread})`;
}

export function formatStatus(view) {
  const lines = [`Swarm "${view.title}" — seq ${view.seq}`];
  if (view.plan?.goal) lines.push(`Goal: ${view.plan.goal}`);
  lines.push(`Members: ${view.counts.members} (${view.counts.active} active worker${view.counts.active === 1 ? '' : 's'})`);
  for (const member of view.members) lines.push(memberLine(member));
  const last = view.messages.at(-1);
  if (last) lines.push(`Latest [${last.seq}] ${last.author}#${last.channel}: ${truncateText(last.text, 240)}`);
  return lines.join('\n');
}

export function registerSwarmTools(host) {
  const register = (definition, when) => {
    host.ctx.tools.register(definition, { when });
  };

  register(
    {
      name: 'swarm',
      description:
        'Swarm coordinator control. Only the root/lead session may use it. Actions: status, add (native teammate), kill, pause, resume, title, goal, post, reconcile, channel-create, channel-list, channel-archive, channel-subscribe, channel-unsubscribe. Members use post_message/read_board/swarm_wait instead.',
      parameters: schema(
        {
          action: {
            type: 'string',
            enum: [
              'status',
              'add',
              'kill',
              'pause',
              'resume',
              'title',
              'goal',
              'plan',
              'post',
              'reconcile',
              'channel-create',
              'channel-list',
              'channel-archive',
              'channel-subscribe',
              'channel-unsubscribe',
            ],
            description: 'Coordinator action.',
          },
          name: { type: 'string', description: 'Member name for add; target name for kill/pause/resume.' },
          prompt: { type: 'string', description: 'Full initial task for a new member.' },
          role: { type: 'string', enum: ['worker', 'monitor'], description: 'Member role (default worker).' },
          channels: { type: 'array', items: { type: 'string' }, description: 'Channels the member joins; missing channels are created first (default main).' },
          member: { type: 'string', description: 'Target member name (alias for name on management actions).' },
          title: { type: 'string', description: 'New board title.' },
          goal: { type: 'string', description: 'Plan goal; tasks/threads are preserved.' },
          plan: {
            type: 'object',
            additionalProperties: true,
            description: 'Full plan for action=plan: {goal:string|{title,line}, tasks:array|object, threads:array|object}.',
          },
          text: { type: 'string', description: 'Post text when action=post.' },
          channel: { type: 'string', description: 'Channel name for post/channel-* actions.' },
          topic: { type: 'string', description: 'Channel topic for channel-create.' },
        },
        ['action'],
      ),
      output: { schema: OUTPUT, render: (_args, value) => json(value) },
      isConcurrencySafe: false,
      async execute(args, exec) {
        try {
          const entry = host.ensureRoot(exec.agent);
          await host.activateRoot(exec.agent);
          const rootId = entry.rootId;
          switch (args.action) {
            case 'status': {
              const view = host.view(rootId, { messageLimit: 8, textLimit: 240 });
              return { ok: true, view, summary: formatStatus(view) };
            }
            case 'add': {
              const member = await host.addMember({
                rootAgent: exec.agent,
                name: args.name,
                prompt: args.prompt,
                role: args.role ?? 'worker',
                channels: args.channels,
                signal: exec.signal,
              });
              return {
                ok: true,
                member: member.member,
                message: `Added ${member.member.name}. It starts in the shared workspace and will read the board.`,
              };
            }
            case 'kill':
            case 'pause':
            case 'resume': {
              const target = args.member ?? args.name;
              if (!target) throw failure('INVALID_ARGUMENT', `${args.action} requires a member name`);
              const member =
                args.action === 'kill'
                  ? await host.killMember(rootId, target)
                  : args.action === 'pause'
                    ? await host.pauseMember(rootId, target)
                    : await host.resumeMember(rootId, target);
              return { ok: true, member };
            }
            case 'title': {
              const out = await host.state.act(rootId, rootId, { type: 'setTitle', title: args.title });
              if (!out.result.ok) throw failure(out.result.code, out.result.message);
              return { ok: true, title: out.result.title };
            }
            case 'goal': {
              if (!args.goal) throw failure('INVALID_ARGUMENT', 'goal text is required');
              const out = await host.state.act(rootId, rootId, { type: 'setGoal', goal: args.goal });
              if (!out.result.ok) throw failure(out.result.code, out.result.message);
              return { ok: true, plan: out.result.plan };
            }
            case 'plan': {
              const plan = validatePublicPlan(args.plan);
              const out = await host.state.act(rootId, rootId, { type: 'setPlan', plan });
              if (!out.result.ok) throw failure(out.result.code, out.result.message);
              return { ok: true, plan: out.result.plan };
            }
            case 'post': {
              const result = await host.post(rootId, rootId, args.text, args.channel);
              if (!result.ok) throw failure(result.code, result.message);
              return { ok: true, seq: result.seq, message: result.message };
            }
            case 'reconcile': {
              const live = (host.ctx.agents?.list?.() ?? []).map((agent) => agent.id);
              const out = await host.state.act(rootId, rootId, {
                type: 'reconcile',
                liveSessionIds: live,
              });
              if (!out.result.ok) throw failure(out.result.code, out.result.message);
              return { ok: true, result: out.result };
            }
            case 'channel-create': {
              if (!args.channel) throw failure('INVALID_ARGUMENT', 'channel is required');
              return { ok: true, ...(await host.createChannel(rootId, args.channel, args.topic)) };
            }
            case 'channel-list': {
              return { ok: true, channels: await host.listChannels(rootId) };
            }
            case 'channel-archive': {
              if (!args.channel) throw failure('INVALID_ARGUMENT', 'channel is required');
              return { ok: true, ...(await host.archiveChannel(rootId, args.channel)) };
            }
            case 'channel-subscribe': {
              if (!args.channel) throw failure('INVALID_ARGUMENT', 'channel is required');
              const target = args.member ?? args.name;
              return { ok: true, ...(await host.subscribeChannel(rootId, args.channel, target)) };
            }
            case 'channel-unsubscribe': {
              if (!args.channel) throw failure('INVALID_ARGUMENT', 'channel is required');
              const target = args.member ?? args.name;
              return { ok: true, ...(await host.unsubscribeChannel(rootId, args.channel, target)) };
            }
            default:
              throw failure('INVALID_ARGUMENT', `unknown swarm action "${args.action}"`);
          }
        } catch (error) {
          return toolError(error);
        }
      },
    },
    (context) => host.canUseSwarmTool(context.agent),
  );

  register(
    {
      name: 'post_message',
      description:
        'Post a message to the Swarm board. Mention members by name (@name) or @all; @#channel mentions a channel. Use this for status and results.',
      parameters: schema(
        {
          text: { type: 'string', description: 'Message text; mention members with @name.' },
          channel: { type: 'string', description: 'Channel name (default main).' },
        },
        ['text'],
      ),
      output: { schema: OUTPUT, render: (_args, value) => json(value) },
      isConcurrencySafe: false,
      async execute(args, exec) {
        try {
          const entry = host.ensureMember(exec.agent);
          await host.activateRoot(host.state.rootAgent(entry.rootId));
          const result = await host.post(entry.rootId, exec.agent.id, args.text, args.channel);
          if (!result.ok) throw failure(result.code, result.message);
          return { ok: true, seq: result.seq, message: result.message };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    (context) => host.canUseSocialTool(context.agent),
  );

  register(
    {
      name: 'read_board',
      description:
        'Read Swarm board messages since your cursor. A normal read advances your cursor and clears delivered wakes; peek=true only inspects. The result includes resolved targets.',
      parameters: schema({
        since: { type: 'integer', minimum: 0, description: 'First sequence to include (default: your cursor).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max messages (default 100).' },
        seqs: { type: 'array', items: { type: 'integer' }, description: 'Read specific sequence numbers.' },
        channel: { type: 'string', description: 'Only this channel.' },
        peek: { type: 'boolean', description: 'Do not advance the cursor.' },
      }),
      output: { schema: OUTPUT, render: (_args, value) => json(value) },
      isConcurrencySafe: false,
      async execute(args, exec) {
        try {
          const entry = host.ensureMember(exec.agent);
          await host.activateRoot(host.state.rootAgent(entry.rootId));
          const result = await host.read(entry.rootId, exec.agent.id, args);
          if (!result.ok) throw failure(result.code, result.message);
          return { ok: true, ...result };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    (context) => host.canUseSocialTool(context.agent),
  );

  register(
    {
      name: 'swarm_wait',
      description:
        'Park this turn until a Swarm wake. If unread messages exist, returns UNREAD with them instead of parking (read first). A successful wait ends the turn; a mention or wake resumes you.',
      parameters: schema({
        since: { type: 'integer', minimum: 0, description: 'Cursor to wait from (default: your last read).' },
        mentionsOnly: { type: 'boolean', description: 'Only wake for mentions (default per member wakeMode).' },
      }),
      output: { schema: OUTPUT, render: (_args, value) => json(value) },
      isConcurrencySafe: false,
      async execute(args, exec) {
        try {
          const entry = host.ensureMember(exec.agent);
          await host.activateRoot(host.state.rootAgent(entry.rootId));
          const result = await host.wait(entry.rootId, exec.agent.id, args);
          if (result.ok && result.waiting) {
            exec.concludeTurn?.();
            return { ok: true, ...result };
          }
          return { ok: false, ...result };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    (context) => host.canUseSocialTool(context.agent),
  );
}
