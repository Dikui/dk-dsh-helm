import { failure } from './host-format.js';
import { changeDelivery, listDeliveries } from './host-deliveries.js';
import { addExternal, syncExternal } from './host-external.js';
import { getBoardClock } from './board-clock.js';
import { probeModelRoute } from './model-probe.js';

export const coordinationHelp = [
  '/swarm assign <taskId> <member> "<deliverable>" "<criterion>"',
  '/swarm deliveries [taskId | --offset N]   List or inspect delivery contracts',
  '/swarm submit <taskId> --path "<path>" | --commit <sha> | <version> "<path>"   Owner only',
  '/swarm review <taskId> <submittedSeq> accepted|returned passed|failed <evidence>',
  '/swarm clock [deadline <ISO time with zone>|off | silence <minutes>|off | off]',
  '/swarm probe <provider/model> --confirm-paid   One billable, tool-free request',
  '/swarm external add <name> <private-base-dir> | sync <name>',
];

function usage(example) { throw failure('INVALID_ARGUMENT', `usage: /swarm ${example}`); }
const success = (data) => ({kind:'success', text:JSON.stringify(data)});

export async function coordinationCommand(host, invocation, verb, words) {
  const {agent, signal} = invocation;
  if (['assign','review','deliveries','submit'].includes(verb)) {
    const entry = host.ensureMember(agent);
    const [taskId, a, b, c, ...rest] = words;
    if (verb === 'deliveries') {
      if (words.length > 1 && !(taskId === '--offset' && words.length === 2)) usage('deliveries [taskId | --offset N]');
      return success(listDeliveries(entry, taskId === '--offset' ? {offset:Number(a)} : {taskId}));
    }
    let args;
    if (verb === 'assign' && words.length === 4) args = {taskId, owner:a, deliverable:b, criterion:c};
    else if (verb === 'submit' && words.length === 3) {
      if (a === '--path') args = {taskId, artifactPath:b};
      else if (a === '--commit') args = {taskId, artifactCommit:b};
      else args = {taskId, artifactVersion:a, artifactPath:b};
    } else if (verb === 'review' && words.length >= 5 && ['passed','failed'].includes(c)) {
      args = {taskId, submittedSeq:Number(a), decision:b, checkPassed:c === 'passed', evidence:rest.join(' ')};
    } else usage(coordinationHelp.find(s => s.startsWith(`/swarm ${verb} `)).slice(7));
    return success(await changeDelivery(host, entry, verb, args));
  }
  if (!['clock','probe','external'].includes(verb)) return null;
  const entry = host.ensureRoot(agent);
  if (verb === 'clock') {
    if (!words.length) return success(getBoardClock(entry.board));
    const [mode, value] = words;
    let patch;
    if (words.length === 1 && mode === 'off') patch = {deadlineUtc:null, silenceMs:null};
    else if (words.length === 2 && mode === 'deadline') patch = {deadlineUtc:value === 'off' ? null : value};
    else if (words.length === 2 && mode === 'silence') patch = {silenceMs:value === 'off' ? null : Number(value) * 60_000};
    else usage('clock [deadline <ISO time with zone>|off | silence <minutes>|off | off]');
    const {result} = await host.state.act(entry.rootId, agent.id, {type:'setBoardClock', patch});
    if (!result.ok) throw failure(result.code, result.message);
    return success(result.settings);
  }
  if (verb === 'probe') {
    if (words.length !== 2 || words[1] !== '--confirm-paid') usage('probe <provider/model> --confirm-paid (may incur a charge)');
    const result = await probeModelRoute({llm:host.llmService(), rootAgent:agent, route:words[0], confirmPaid:true,
      signal:signal ? AbortSignal.any([signal,host.lifecycle.signal]) : host.lifecycle.signal});
    return {kind:result.ok ? 'success' : 'error', text:JSON.stringify(result)};
  }
  if (words[0] === 'add' && words.length === 3) return success(await addExternal(host, agent, words[1], words[2], signal));
  if (words[0] === 'sync' && words.length === 2) return success(await syncExternal(host, agent, words[1]));
  usage('external add <name> <private-base-dir> | sync <name>');
}
