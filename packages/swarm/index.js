import { openStore } from './src/store.js';
import * as boardApi from './src/board.js';
import * as channelApi from './src/channels.js';
import { BoardState } from './src/host-state.js';
import { SwarmHost } from './src/host-runtime.js';
import { registerSwarmTools } from './src/host-tools.js';
import { registerSwarmCommands } from './src/host-commands.js';
import { registerSwarmLive, registerSwarmMode } from './src/host-live.js';

export const name = 'dk-dsh-swarm';
export const inject = ['storageDomain', 'subagents', 'tools', 'commands', 'workingDirectory', 'agents'];

/**
 * Host half of Swarm. The board/state machine lives in board.js (core); this
 * module owns durability, native member spawn, wake delivery, turn guards,
 * tools/commands and the bounded read-only view.
 */
export async function apply(ctx) {
  const lifecycle = new AbortController();
  let host = null;

  ctx.effect(() => async () => {
    lifecycle.abort(new Error('swarm plugin disposed'));
    if (host) await host.close();
  });

  const store = await openStore(ctx);
  const state = new BoardState({
    ctx,
    store,
    board: boardApi,
    channels: channelApi,
    logger: ctx.logger,
  });
  host = new SwarmHost({
    ctx,
    store,
    state,
    channels: channelApi,
    logger: ctx.logger,
  });
  await host.start();

  registerSwarmTools(host);
  registerSwarmCommands(host);
  registerSwarmLive(host);
  registerSwarmMode(host);

  return () => host?.close();
}
