import { READ_RENDER_LIMIT } from './board.js';
import { asHostError, byteLength, failure, isPlainObject, truncateText } from './host-format.js';

import { changeDelivery, listDeliveries } from './host-deliveries.js';

const OUTPUT = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  additionalProperties: true,
  required: ['ok'],
};

function json(value) {
  const text = JSON.stringify(value, null, 2);
  return [{ type: 'text', text: truncateText(text, READ_RENDER_LIMIT) }];
}

// read_board already cuts pages by the rendered envelope; truncating it again
// would silently drop the tail of the last message on the page.
function jsonExact(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
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

const routeSchema = (description) => ({
  ...schema({ provider: { type: 'string', minLength: 1, maxLength: 120 }, model: { type: 'string', minLength: 1, maxLength: 200 } }, ['provider', 'model']), description,
});

function memberLine(member) {
  const role = member.role === 'coordinator' ? 'lead' : member.role;
  const unread = member.unread ? `, ${member.unread} unread` : '';
  const options = [member.workspaceMode === 'branch' && 'Git worktree', member.model, member.fallback && `fallback: ${member.fallback}`].filter(Boolean);
  return `- ${member.name} (${[role, `${member.status}${unread}`, ...options].join(', ')})`;
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
        'Swarm coordinator control. Only the root/lead session may use it. Actions: status, add (native teammate; optional routed model and isolated checkout), merge (explicit delivery), kill, pause, resume, title, goal, post, reconcile, channel-create, channel-list, channel-archive, channel-subscribe, channel-unsubscribe. Members use post_message/read_board/swarm_wait instead.',
      parameters: schema(
        {
          action: {
            type: 'string',
            enum: [
              'status',
              'add',
              'merge',
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
          workspaceMode: { type: 'string', enum: ['share', 'branch'], description: 'For add: shared cwd (default) or an isolated Git worktree from committed HEAD.' },
          modelRoute: routeSchema('For add: authorized provider and model. Default inherits.'),
          fallbackRoute: routeSchema('For add: one authorized alternative to continue the same member after quota errors.'),
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
                modelRoute: args.modelRoute,
                fallbackRoute: args.fallbackRoute,
                workspaceMode: args.workspaceMode,
                signal: exec.signal,
              });
              return {
                ok: true,
                member: member.member,
                message: `Added ${member.member.name}. Workspace: ${member.member.worktreePath ?? 'shared with the lead'}.`,
              };
            }
            case 'merge': {
              const delivery = await host.mergeMember(exec.agent, args.member ?? args.name, exec.signal);
              return { ok: true, delivery };
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

  register({
    name: 'swarm_delivery',
    description: 'Optional delivery contracts. list (taskId for full details, offset for next page); the lead assigns to a member by name and reviews its exact submittedSeq after checking the artifact. Only the owner submits its version and path. A done post is not acceptance.',
    parameters: schema({
      action: { type:'string', enum:['list','assign','submit','review'] },
      taskId:{type:'string'}, offset:{type:'integer',minimum:0}, owner:{type:'string'}, deliverable:{type:'string'}, criterion:{type:'string'},
      artifactVersion:{type:'string'}, artifactPath:{type:'string'}, submittedSeq:{type:'integer',minimum:1},
      decision:{type:'string',enum:['accepted','returned']}, checkPassed:{type:'boolean'}, evidence:{type:'string'},
    }, ['action']),
    output:{schema:OUTPUT, render:(_args, value) => jsonExact(value)}, isConcurrencySafe:false,
    async execute(args, exec) {
      try {
        const entry = host.ensureMember(exec.agent);
        if (args.action === 'list') return listDeliveries(entry, args);
        return await changeDelivery(host, entry, args.action, args);
      } catch (error) { return toolError(error); }
    },
  }, ({agent}) => {
    const e = host.state.resolve(agent);
    return Boolean(e?.self && !['paused','killed'].includes(e.status) && (e.isRoot ? (Object.keys(e.board.members).length > 1) : e.board.deliveries?.some(d => d.owner === agent.id)));
  });

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
        'Read Swarm board messages since your cursor. A normal read advances your cursor and clears delivered wakes; peek=true only inspects. The result includes resolved targets. Pages are sized by the rendered JSON: when hasMore is true, repeat the same filters with since set to nextSince. A peek page never advances the cursor. A single legal post is always returned whole.',
      parameters: schema({
        since: { type: 'integer', minimum: 0, description: 'Exclusive lower bound (default: your cursor, or zero for explicit seqs).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max messages (default 100).' },
        seqs: { type: 'array', items: { type: 'integer' }, description: 'Read specific sequence numbers.' },
        channel: { type: 'string', description: 'Only this channel.' },
        peek: { type: 'boolean', description: 'Do not advance the cursor.' },
      }),
      output: { schema: OUTPUT, render: (_args, value) => jsonExact(value) },
      isConcurrencySafe: false,
      async execute(args, exec) {
        try {
          const entry = host.ensureMember(exec.agent);
          await host.activateRoot(host.state.rootAgent(entry.rootId));
          const preview = args.peek !== true;
          if (preview && exec.token == null) {
            throw failure('MISSING_DELIVERY_TOKEN', 'Cannot confirm this read without a tool execution token.');
          }
          const result = await host.read(entry.rootId, exec.agent.id, {
            ...args,
            ...(preview ? { preview: true } : {}),
          });
          if (!result.ok) throw failure(result.code, result.message);
          const page = { ok: true, ...result };
          if (preview) {
            host.armReadDelivery({
              token: exec.token,
              rootId: entry.rootId,
              agentId: exec.agent.id,
              seqs: result.messages.map((message) => message.seq),
              content: jsonExact(page),
            });
          }
          return page;
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
