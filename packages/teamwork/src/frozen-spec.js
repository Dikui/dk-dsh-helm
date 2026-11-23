/**
 * The single formatter for the frozen campaign specification.
 *
 * Campaign task prompts and host role envelopes both render the confirmed
 * spec. Sharing this formatter keeps the integrity restrictions, standard
 * library rule, and interview constraints identical in every place the model
 * is asked to rely on them.
 */

const FROZEN_SPEC_HEADING = 'FROZEN CAMPAIGN SPEC (authoritative; confirmed by the human; do not weaken, narrow, or replace it)'

/**
 * @param {unknown} values
 * @returns {string}
 */
function list(values) {
  return Array.isArray(values) && values.length > 0
    ? values.map(value => String(value).trim()).filter(Boolean).join('; ')
    : 'none recorded'
}

/**
 * @param {object} spec - confirmed campaign spec.
 * @param {object} [options]
 * @param {string} [options.cwd] - campaign workspace, used when spec.workdir is empty.
 * @param {string} [options.route] - selected campaign route.
 * @param {boolean} [options.heading] - include the authoritative heading (default true).
 * @returns {string}
 */
export function formatFrozenSpec(spec, { cwd = '', route = '', heading = true } = {}) {
  const source = spec && typeof spec === 'object' ? spec : {}
  const objectiveLine = typeof source.text === 'string'
    ? source.text.split('\n').find(line => line.startsWith('Objective:')) || ''
    : ''
  const objective = objectiveLine.slice('Objective:'.length).trim() || 'see frozen spec'
  const integrity = source.integrity && typeof source.integrity === 'object' ? source.integrity : {}
  const lines = []
  if (heading) lines.push(FROZEN_SPEC_HEADING)
  lines.push(
    `Objective: ${objective}`,
    ...(route ? [`Route: ${route}`] : []),
    `Workdir: ${String(source.workdir || cwd || '')}`,
    `Acceptance: ${String(source.acceptance || source.confirmedCommand || '')}`,
    `Verification command: ${String(source.confirmedCommand || 'not set')}`,
    `Deliverables: ${list(source.deliverables)}`,
    `Constraints: ${list(source.constraints)}`,
    `Files: ${list(source.files)}`,
    `Integrity mode: ${String(integrity.mode || 'not recorded')}`,
    `Integrity selections: ${list(integrity.selected)}`,
    `Integrity restrictions: ${list(integrity.notAllowed)}`,
    `Standard library only: ${integrity.standardLibraryOnly ? 'yes' : 'no'}`,
  )
  return lines.join('\n')
}
