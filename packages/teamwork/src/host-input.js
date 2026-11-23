/**
 * Parser for the `/teamwork` command line.
 *
 * The command input is exact text after the command name, including the leading
 * separator whitespace. New-run input is line based so a task can span lines
 * and the human's acceptance command can be kept to exactly one line.
 *
 *   /teamwork [skip] --mode swe-light|general [--cwd <dir>] <task>
 *   @check <one-line acceptance command>
 *   @cwd <workspace dir>
 *   @file <path>            (0-4 lines)
 *
 * Existing runs are addressed with one of:
 *   /teamwork status|dossier [runId]
 *   /teamwork confirm <runId> <token>   (must equal the draft confirmLine exactly)
 *   /teamwork answer <runId> <key> <value...>
 *   /teamwork pause|resume|cancel [runId]
 */

export const MODES = Object.freeze(['swe-light', 'general'])
export const MAX_TASK_CHARS = 20000
export const MAX_COMMAND_CHARS = 2000
export const MAX_FILES = 4

export const USAGE = `Teamwork runs a small, evidence-gated team: implement, independent read-only verification, then a fresh victory audit. Nothing starts until you type the draft's confirmation line yourself.

New run
  /teamwork [skip] --mode swe-light|general <task...>
  @check <one-line acceptance command>     required; the only command the host runs
  @cwd <workspace directory>               optional; defaults to the session workspace
  @file <path>                             optional; 0-4 files the reviewers must inspect

  skip omits the structured interview. Both paths show a draft and wait for a
  separate chat message; no UI click can confirm it.

Existing run
  /teamwork status [runId]
  /teamwork dossier [runId]                read-only Markdown acceptance dossier
  /teamwork answer <runId> <key> <value>   one interview answer at a time
  /teamwork confirm <runId> <token>        copy the draft line exactly, token included
  /teamwork pause [runId]                  cooperative pause; persists a resumable state
  /teamwork resume [runId]                 re-enter a paused run
  /teamwork cancel [runId]                 terminal; releases the workspace lease

Limits: one active teamwork run per workspace; one main acceptance process
(this host); no browser, profile, push, or nested delegation; children use
their own fresh sessions and role presets. Implementer writes are scoped by
tool policy and prompt to the workspace; this is not an OS jail. Reviewers and
auditors have no write or shell tool.`

/**
 * @param {string} rawInput - exact text after the command name.
 * @returns {{kind: string, [key: string]: unknown}} parsed command.
 */
export function parseTeamworkInput(rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput.replace(/\r\n?/gu, '\n') : ''
  const lines = raw.split('\n')
  const first = (lines[0] ?? '').trim()

  if (first === '' || first === 'help' || first === '--help' || first === '-h') return { kind: 'help' }

  const firstWords = first.split(/\s+/u)
  const head = firstWords[0].toLowerCase()

  if (head === 'status') return { kind: 'status', runId: firstWords[1] }
  if (head === 'dossier') {
    if (firstWords.length > 2) return { kind: 'error', message: 'Usage: /teamwork dossier [runId]' }
    return { kind: 'dossier', runId: firstWords[1] }
  }
  if (head === 'pause') return { kind: 'pause', runId: firstWords[1] }
  if (head === 'resume') return { kind: 'resume', runId: firstWords[1] }
  if (head === 'cancel') return { kind: 'cancel', runId: firstWords[1] }
  if (head === 'list') {
    if (firstWords.length > 1 || lines.slice(1).some(line => line.trim() !== '')) {
      return { kind: 'error', message: 'Usage: /teamwork list' }
    }
    return { kind: 'list' }
  }
  if (head === 'confirm') {
    return {
      kind: 'confirm',
      runId: firstWords[1],
      // Exact human text of this command invocation; it must equal the draft line.
      text: raw.trim(),
      extra: firstWords.slice(2).join(' ').trim() || undefined,
    }
  }
  if (head === 'answer') return parseAnswer(first, lines.slice(1))
  if (head === 'new') return parseNewRun([firstWords.slice(1).join(' '), ...lines.slice(1)].join('\n'))

  return parseNewRun(raw)
}

/**
 * @param {string} first - full first line.
 * @param {string[]} rest - remaining lines.
 */
function parseAnswer(first, rest) {
  const words = first.trim().split(/\s+/u)
  const runId = words[1]
  const key = words[2]
  if (!runId || !key) return { kind: 'error', message: 'Usage: /teamwork answer <runId> <key> <value...>' }
  const inline = words.slice(3).join(' ')
  const value = inline.length > 0 ? inline : rest.join('\n').trim()
  if (!value) return { kind: 'error', message: `Missing value for interview answer "${key}".` }
  return { kind: 'answer', runId, values: { [key]: value } }
}

/**
 * Parse the new-run form, including line-oriented @ directives.
 * @param {string} raw - raw input beginning at the task/options.
 */
export function parseNewRun(raw) {
  const lines = String(raw).replace(/\r\n?/gu, '\n').split('\n')
  let mode
  let skip = false
  let cwd
  let command
  let checkLineCount = 0
  const files = []
  const taskLines = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      taskLines.push('')
      continue
    }
    if (/^@check(?:\s|$)/iu.test(trimmed)) {
      checkLineCount += 1
      const value = trimmed.replace(/^@check(?:\s+|$)/iu, '').trim()
      if (!value) return { kind: 'error', message: '@check needs a command on the same line.' }
      if (command !== undefined) return { kind: 'error', message: 'Only one @check line is allowed.' }
      if (value.length > MAX_COMMAND_CHARS) {
        return { kind: 'error', message: `@check is too long (${value.length} > ${MAX_COMMAND_CHARS} characters).` }
      }
      command = value
      continue
    }
    if (/^@cwd(?:\s|$)/iu.test(trimmed)) {
      const value = trimmed.replace(/^@cwd(?:\s+|$)/iu, '').trim()
      if (!value) return { kind: 'error', message: '@cwd needs a directory on the same line.' }
      if (cwd !== undefined) return { kind: 'error', message: 'Only one @cwd line is allowed.' }
      cwd = value
      continue
    }
    if (/^@file(?:\s|$)/iu.test(trimmed)) {
      const value = trimmed.replace(/^@file(?:\s+|$)/iu, '').trim()
      if (!value) return { kind: 'error', message: '@file needs a path on the same line.' }
      if (files.length >= MAX_FILES) return { kind: 'error', message: `At most ${MAX_FILES} @file lines are allowed.` }
      files.push(value)
      continue
    }
    if (trimmed.startsWith('@')) return { kind: 'error', message: `Unknown directive: ${trimmed.split(/\s+/u)[0]} (expected @check, @cwd, or @file as standalone keywords)` }
    taskLines.push(line)
  }

  const firstTaskLine = taskLines.find(line => line.trim() !== '')
  if (firstTaskLine !== undefined) {
    const words = firstTaskLine.trim().split(/\s+/u)
    const kept = []
    for (const word of words) {
      const lower = word.toLowerCase()
      if (lower === 'skip' || lower === '--skip') {
        skip = true
        continue
      }
      if (lower.startsWith('--mode=')) {
        if (mode !== undefined) return { kind: 'error', message: 'Specify --mode only once.' }
        mode = word.slice('--mode='.length).toLowerCase()
        continue
      }
      kept.push(word)
    }
    const modeIndex = kept.findIndex(word => word.toLowerCase() === '--mode')
    if (modeIndex >= 0) {
      if (mode !== undefined) return { kind: 'error', message: 'Specify --mode only once.' }
      const value = kept[modeIndex + 1]
      if (!value) return { kind: 'error', message: '--mode needs a value.' }
      mode = value.toLowerCase()
      kept.splice(modeIndex, 2)
    }
    // Replace only the first non-empty line with its cleaned form.
    const index = taskLines.indexOf(firstTaskLine)
    taskLines[index] = kept.join(' ')
  }

  const task = taskLines.join('\n').trim()
  if (!task) return { kind: 'error', message: 'A task description is required.' }
  if (task.length > MAX_TASK_CHARS) {
    return { kind: 'error', message: `The task is too long (${task.length} > ${MAX_TASK_CHARS} characters).` }
  }
  if (mode === undefined) {
    return { kind: 'error', message: 'Pick a mode explicitly: --mode swe-light or --mode general.' }
  }
  if (!MODES.includes(mode)) {
    return { kind: 'error', message: `Unknown mode "${mode}". Use --mode swe-light or --mode general.` }
  }
  if (command === undefined) {
    return {
      kind: 'error',
      message: 'An acceptance command is required: add a line `@check <one command>`. It is the only shell line the host runs, exactly as you typed it.',
    }
  }

  return { kind: 'new', skip, mode, task, command, cwd, files }
}

/**
 * The draft's confirmation line must match the human's typed command exactly.
 * Only the optional `/teamwork` command prefix is normalised away; no fuzzy
 * matching, no model-generated text, no UI auto-confirm.
 * @param {string} typed - trimmed raw input of the confirmation invocation.
 * @param {string} confirmLine - draft.confirmLine shown to the human.
 * @returns {boolean}
 */
export function matchesConfirmLine(typed, confirmLine) {
  if (typeof typed !== 'string' || typeof confirmLine !== 'string') return false
  const a = typed.trim()
  const b = confirmLine.trim()
  if (!a || !b) return false
  if (a === b) return true
  const strip = value => value.replace(/^\/teamwork\s+/iu, '').trim()
  return strip(a) === strip(b)
}

/**
 * @param {string} value - proposed run id.
 * @returns {boolean}
 */
export function isValidRunId(value) {
  return typeof value === 'string' && /^tw-[a-z0-9]+-[a-f0-9]{6}$/u.test(value)
}

/**
 * Choose a readable label for a role task.
 * @param {{id?: string, role?: string}} task
 */
export function taskLabel(task) {
  return [task?.role, task?.id].filter(Boolean).join(' ')
}
