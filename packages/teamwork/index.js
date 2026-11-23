/**
 * `/teamwork` Host entrypoint.
 *
 * The command layer owns UX and the run loop; campaign/interview own the
 * durable state machine and the draft/confirmation contract. The four role
 * presets are installed by cordis.patch.yml and each bundles the same role
 * policy with a different tool allowlist.
 */

import * as campaign from './src/campaign.js'
import * as interview from './src/interview.js'
import * as dossier from './src/dossier.js'
import { apply as applyCommand } from './src/host-command.js'

export const name = 'dk-teamwork-command'
export const inject = ['commands', 'subagents', 'workingDirectory', 'fs', 'tools', 'storageDomain']

export function apply(ctx) {
  return applyCommand(ctx, { campaign, interview, dossier })
}
