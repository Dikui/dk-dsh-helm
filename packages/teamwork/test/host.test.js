import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { parseTeamworkInput, matchesConfirmLine, USAGE } from '../src/host-input.js'
import { parseAuditReport, parseRoleVerdict, buildRolePrompt, buildEvidencePackage } from '../src/host-text.js'
import { apply as applyPolicy } from '../src/policy.js'

test('new-run directives are standalone keywords and unsafe spellings fail', () => {
  const parsed = parseTeamworkInput(`skip --mode swe-light fix the thing
@check node --test
@cwd /tmp/work
@file src/a.js
@file src/b.js`)
  assert.equal(parsed.kind, 'new')
  assert.equal(parsed.mode, 'swe-light')
  assert.equal(parsed.skip, true)
  assert.equal(parsed.task, 'fix the thing')
  assert.equal(parsed.command, 'node --test')
  assert.equal(parsed.cwd, '/tmp/work')
  assert.deepEqual(parsed.files, ['src/a.js', 'src/b.js'])

  assert.equal(parseTeamworkInput('--mode general task\n@checklater echo no').kind, 'error')
  assert.equal(parseTeamworkInput('--mode general task\n@checkx echo no').kind, 'error')
  assert.equal(parseTeamworkInput('task without mode\n@check true').kind, 'error')
  assert.equal(parseTeamworkInput('--mode general task').kind, 'error')
  assert.equal(parseTeamworkInput('--mode fast task\n@check true').kind, 'error')
  assert.match(USAGE, /confirm <runId> <token>/u)
})

test('confirmation must be the exact typed line, not a model paraphrase', () => {
  assert.equal(matchesConfirmLine('confirm tw-abc-123456', 'confirm tw-abc-123456'), true)
  assert.equal(matchesConfirmLine('/teamwork confirm tw-abc-123456', 'confirm tw-abc-123456'), true)
  assert.equal(matchesConfirmLine('yes go ahead', 'confirm tw-abc-123456'), false)
  assert.equal(matchesConfirmLine('confirm tw-abc-123456 please', 'confirm tw-abc-123456'), false)
  assert.equal(matchesConfirmLine('confirm tw-abc-123456 tw1_deadbeef', 'confirm tw-abc-123456 tw1_deadbeef'), true)
  assert.equal(matchesConfirmLine('confirm tw-abc-123456', 'confirm tw-abc-123456 tw1_deadbeef'), false, 'a missing token is not confirmation')
})

test('reviewer verdict is fail-closed: veto dominates and evidence-free FIXED is ignored', () => {
  const vetoed = parseRoleVerdict('VERDICT|veto|integrity violation\nVERDICT|pass|looks fine')
  assert.equal(vetoed.verdict, 'veto')
  assert.ok(vetoed.warnings.some(warning => /VETO dominates/u.test(warning)))

  const conflict = parseRoleVerdict('VERDICT|pass|ok\nVERDICT|fail|not ok')
  assert.equal(conflict.verdict, 'fail')

  const noEvidence = parseRoleVerdict('VERDICT|pass|ok\nFIXED|ISSUE-1')
  assert.deepEqual(noEvidence.fixed, [])
  assert.ok(noEvidence.warnings.some(warning => /without usable evidence/u.test(warning)))

  const placeholder = parseRoleVerdict('VERDICT|pass|ok\nFIXED|ISSUE-1|not stated')
  assert.deepEqual(placeholder.fixed, [])

  const real = parseRoleVerdict('VERDICT|pass|ok\nFIXED|ISSUE-1|src/a.js:10 returns the computed value')
  assert.equal(real.fixed.length, 1)

  const malformedIssue = parseRoleVerdict('VERDICT|pass|ok\nISSUE|major|bug|src/a.js:1')
  assert.equal(malformedIssue.verdict, 'fail')
  assert.equal(malformedIssue.issues.length, 0)

  assert.equal(parseRoleVerdict('no verdict here').verdict, 'fail')
})

test('auditor pass requires all three phases and a veto cannot be overwritten', () => {
  assert.equal(parseAuditReport('VERDICT|pass|ok').verdict, 'fail')
  assert.equal(parseAuditReport('VERDICT|pass|ok\nPHASE A|a').verdict, 'fail')
  assert.equal(parseAuditReport('VERDICT|pass|ok\nPHASE A|narrative\nPHASE B|pass\nPHASE C|pass').verdict, 'fail')
  assert.equal(parseAuditReport('VERDICT|pass|ok\nPHASE A|fail\nPHASE A|pass\nPHASE B|pass\nPHASE C|pass').verdict, 'fail')
  const ok = parseAuditReport('VERDICT|pass|ok\nPHASE A|pass|trace checked\nPHASE B|pass|no test edits\nPHASE C|pass|receipt exit 0')
  assert.equal(ok.verdict, 'pass')
  assert.deepEqual(ok.phases, { a: 'pass', b: 'pass', c: 'pass' })
  const vetoed = parseAuditReport('VERDICT|veto|fraud\nVERDICT|pass|ok\nPHASE A|a\nPHASE B|b\nPHASE C|c')
  assert.equal(vetoed.verdict, 'veto')
})

test('reviewer and audit reports are parsed in full, not from a 20k prefix', () => {
  const padding = 'a'.repeat(25000)
  const roleVeto = parseRoleVerdict(`${padding}\nVERDICT|pass|prefix looks fine\nVERDICT|veto|the tail veto wins`)
  assert.equal(roleVeto.verdict, 'veto')
  assert.equal(roleVeto.reason, 'the tail veto wins')

  const roleLeadingVeto = parseRoleVerdict(`VERDICT|veto|leading veto\n${padding}\nVERDICT|pass|ok`)
  assert.equal(roleLeadingVeto.verdict, 'veto')

  const auditVeto = parseAuditReport([
    'PHASE A|pass|trace checked', 'PHASE B|pass|no edits', 'PHASE C|pass|receipt',
    padding, 'VERDICT|pass|prefix ok', 'VERDICT|veto|tail audit veto',
  ].join('\n'))
  assert.equal(auditVeto.verdict, 'veto')
  assert.deepEqual(auditVeto.phases, { a: 'pass', b: 'pass', c: 'pass' })

  const auditPrefix = parseAuditReport([
    'VERDICT|pass|ok', 'PHASE A|pass|a', 'PHASE B|pass|b', 'PHASE C|pass|c', padding,
  ].join('\n'))
  assert.equal(auditPrefix.verdict, 'pass')
})

test('oversized reports fail closed instead of being truncated and accepted', () => {
  const oversized = 'x'.repeat(512 * 1024 + 1)
  const role = parseRoleVerdict(`${oversized}\nVERDICT|pass|ok`)
  assert.equal(role.verdict, 'fail')
  assert.match(role.reason, /exceeds the .* parse limit/u)
  assert.ok(role.warnings.some(warning => /not parsed/u.test(warning)))

  const audit = parseAuditReport(`${oversized}\nVERDICT|pass|ok\nPHASE A|pass\nPHASE B|pass\nPHASE C|pass`)
  assert.equal(audit.verdict, 'fail')
  assert.match(audit.reason, /exceeds the .* parse limit/u)
})

test('report storage clips display fields without dropping semantic entries', () => {
  const longSummary = 's'.repeat(1000)
  const lines = ['VERDICT|pass|ok']
  for (let i = 0; i < 300; i += 1) lines.push(`ISSUE|low|${longSummary}|src/a.js:${i}`)
  lines.push('ISSUE|integrity|late integrity finding|src/a.js:300')
  const report = parseRoleVerdict(lines.join('\n'))
  assert.equal(report.verdict, 'pass')
  assert.equal(report.issues.length, 301)
  assert.equal(report.issues.at(-1).severity, 'integrity')
  assert.ok(report.issues[0].summary.length < 600)
  assert.ok(!report.warnings.some(warning => /additional ISSUE entries/u.test(warning)))

  const malformed = ['VERDICT|pass|ok']
  for (let i = 0; i < 100; i += 1) malformed.push(`ISSUE|bogus|bad|src/a.js:${i}`)
  const boundedWarnings = parseRoleVerdict(malformed.join('\n'))
  assert.ok(boundedWarnings.warnings.length <= 51)
  assert.ok(boundedWarnings.warnings.some(warning => /Additional warnings omitted/u.test(warning)))
})

test('the frozen spec reaches execution, review, and audit prompts as authoritative data', () => {
  const spec = {
    text: 'Objective: Build the ledger\nWorkdir: /tmp/work',
    workdir: '/tmp/work',
    acceptance: 'npm test',
    confirmedCommand: 'npm test',
    deliverables: ['src/ledger.js', 'tests'],
    constraints: ['Node 22', 'no dependencies'],
    files: ['src/ledger.js'],
    integrity: {
      mode: 'benchmark',
      selected: ['a', 'b', 'c', 'd'],
      notAllowed: ['dependencies outside the standard library', 'hardcoded acceptance output'],
      standardLibraryOnly: true,
    },
  }
  for (const role of ['implementer', 'reviewer', 'auditor', 'explorer']) {
    const prompt = buildRolePrompt({
      role, taskId: `${role}-1`, mode: 'general', runId: 'tw-abc-123456',
      cwd: '/tmp/work', taskPrompt: 'Do the task.', spec,
      originalRequest: 'Build the ledger.',
    })
    assert.match(prompt, /FROZEN CAMPAIGN SPEC \(authoritative/u)
    assert.match(prompt, /ORIGINAL REQUEST \(historical context; the confirmed frozen campaign spec, when present, is authoritative on conflict\)/u)
    assert.match(prompt, /Integrity restrictions: dependencies outside the standard library; hardcoded acceptance output/u)
    assert.match(prompt, /Standard library only: yes/u)
    assert.match(prompt, /Constraints: Node 22; no dependencies/u)
    assert.match(prompt, /Deliverables: src\/ledger\.js; tests/u)
    assert.match(prompt, /Verification command: npm test/u)
  }
})

test('role prompt states one enum word and never leaks the acceptance command to verifiers', () => {
  const reviewer = buildRolePrompt({
    role: 'reviewer',
    taskId: 'verify-1',
    mode: 'swe-light',
    runId: 'tw-abc-123456',
    cwd: '/tmp/work',
    taskPrompt: 'Review the change.',
  })
  assert.match(reviewer, /VERDICT\|<verdict>\|<reason>/u)
  assert.match(reviewer, /exactly one word: pass, fail, or veto/u)
  assert.match(reviewer, /ISSUE\|<severity>\|<summary>\|<evidence>/u)
  assert.match(reviewer, /low, medium, high, critical, blocker, or integrity/u)
  assert.match(reviewer, /READ-ONLY/u)

  const implementer = buildRolePrompt({
    role: 'implementer',
    taskId: 'impl-1',
    mode: 'general',
    runId: 'tw-abc-123456',
    cwd: '/tmp/work',
    taskPrompt: 'Implement it.',
    originalRequest: 'Build the requested feature.',
    task: { writeScope: 'src/**' },
  })
  assert.match(implementer, /Do not run the human's acceptance command/u)
  assert.match(implementer, /not an OS jail/u)
  assert.match(implementer, /src\/\*\*/u)
})

test('evidence package contains the exact command and exit status', () => {
  const text = buildEvidencePackage({
    check: { command: 'node --test', exitCode: 1, stdout: 'ok', stderr: 'boom', truncated: false },
    files: Array.from({length: 4}, (_, i) => ({ file: `src/${i}.js`, text: 'x'.repeat(2500), clipped: false })),
    ledger: { open: [{ id: 'ISSUE-1', severity: 'high', summary: 'bug', source: 'reviewer:r1' }], closed: [] },
    acceptanceCommand: 'node --test',
  }, 9000)
  assert.match(text, /node --test/u)
  assert.match(text, /exit 1/u)
  assert.match(text, /ISSUE-1/u)
})

function fakeTools(globals) {
  const state = { definitions: globals.map(name => ({ name })), registered: [], restricted: [], guards: [] }
  return {
    state,
    register(definition) {
      state.registered.push(definition)
      return { dispose() {} }
    },
    restrict({ deny }) {
      state.restricted.push(deny)
      return { dispose() {} }
    },
    guard(fn) {
      state.guards.push(fn)
      return { dispose() {} }
    },
    definitions(agent) {
      return agent === undefined ? state.definitions : state.definitions
    },
  }
}

function applyWith(role, tools) {
  applyPolicy({ tools }, { role })
  return tools
}

test('teamwork implementer policy allows writer tools only and guards the tool boundary', () => {
  const globals = ['read', 'glob', 'grep', 'edit', 'write', 'bash', 'subagent', 'read_image', 'apply_patch', 'write_file', 'run_code']
  const tools = fakeTools(globals)
  applyWith('implementer', tools)
  const deny = tools.state.restricted.at(-1)
  assert.deepEqual(new Set(deny), new Set(['subagent', 'read_image', 'apply_patch', 'write_file']))
  assert.equal(deny.includes('run_code'), false)
  assert.equal(tools.state.registered.length, 0)

  const guard = tools.state.guards.at(-1)
  assert.equal(guard({ agent: { id: 'a' }, name: 'read' }), undefined)
  assert.match(String(guard({ agent: { id: 'a' }, name: 'subagent' })), /not allowed for teamwork implementer/u)
  assert.match(String(guard({ name: 'read' })), /require a calling agent/u)
})

test('teamwork reviewer policy has no shell or write tools', () => {
  const globals = ['read', 'glob', 'grep', 'edit', 'write', 'bash', 'subagent', 'run_code']
  const tools = fakeTools(globals)
  applyWith('reviewer', tools)
  const deny = tools.state.restricted.at(-1)
  assert.deepEqual(new Set(deny), new Set(['edit', 'write', 'bash', 'subagent']))
  const guard = tools.state.guards.at(-1)
  assert.match(String(guard({ agent: { id: 'a' }, name: 'bash' })), /not allowed for teamwork reviewer/u)
  assert.match(String(guard({ agent: { id: 'a' }, name: 'run_code' })), /not allowed for teamwork reviewer/u)
})

test('policy fails closed on an unknown role and missing service methods', () => {
  const tools = fakeTools(['read'])
  assert.throws(() => applyPolicy({ tools }, { role: 'intern' }), /config\.role must be one of/u)
  assert.throws(() => applyPolicy({ tools: {} }, { role: 'implementer' }), /ctx\.tools service/u)
})

// ---- command-level behaviour with the real campaign state machine ----------

import * as campaignModule from '../src/campaign.js'
import * as interviewModule from '../src/interview.js'
import { apply as applyTeamworkCommand, acceptanceView } from '../src/host-command.js'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function memoryStorageDomain(initial) {
  const table = new Map(Object.entries(initial ?? {}))
  let opened = false
  const runs = {
    get: key => clone(table.get(key)),
    put: async (key, value) => { table.set(key, clone(value)) },
    entries: () => [...table.entries()].map(([key, value]) => [key, clone(value)]),
  }
  return {
    async open(spec) {
      // The JSON-backed domain refuses a second live open; the host must share
      // one store per command instance instead of opening per campaign call.
      if (opened) throw new Error(`domain '${spec?.name}' is already open`)
      opened = true
      return { table: () => runs, close: async () => { opened = false } }
    },
  }
}

function commandHarness({ responses, hangImplementerFirst = false, storageDomain } = {}) {
  const cwd = '/tmp/teamwork-command'
  const aliases = new Map([['/tmp/teamwork-link', cwd]])
  const children = []
  const createCalls = []
  let hung = false
  let definition
  const effects = []
  const ctx = {
    effect: fn => { effects.push(fn()) },
    storageDomain: storageDomain ?? memoryStorageDomain(),
    commands: {
      register(value) {
        definition = value
        return () => {}
      },
    },
    subagents: {
      rootOf: agent => agent,
      resolveMaxDepth: () => 4,
      startActivation: async spec => {
        children.push(spec)
        const preset = spec.agentPreset ?? ''
        if (hangImplementerFirst && !hung && preset.endsWith('-implementer')) {
          hung = true
          return {
            childId: spec.childId,
            name: spec.childId,
            result: new Promise((_resolve, reject) => {
              spec.signal.addEventListener('abort', () => reject(new Error('aborted by pause')), { once: true })
            }),
            dispose: () => {},
          }
        }
        const text = preset.endsWith('-implementer')
          ? 'CHANGED: implemented\nVERIFY: focused check\nOPEN: none'
          : preset.endsWith('-auditor')
            ? 'VERDICT|pass|looks right\nPHASE A|pass\nPHASE B|pass\nPHASE C|pass'
            : 'VERDICT|pass|verified'
        return {
          childId: spec.childId,
          name: spec.childId,
          result: Promise.resolve({ output: [{ type: 'text', text: responses?.[preset] ?? text }], stopReason: 'completed' }),
          dispose: () => {},
        }
      },
    },
    workingDirectory: { ensure: async () => cwd },
    fs: {
      processPath: target => target.path ?? String(target),
      resolve: async (value, opts) => {
        const raw = String(value).startsWith('/') ? String(value) : `${opts?.cwd ?? cwd}/${value}`
        const canonical = aliases.get(raw) ?? raw
        return { path: canonical, targetKey: canonical }
      },
      contains: (root, target) => String(target.path).startsWith(String(root.path)),
    },
    tools: {
      executable: () => true,
      execute: async ({ calls }) => ({
        results: calls.map(call => {
          const args = JSON.parse(call.arguments)
          if (call.name === 'bash') {
            return { callId: call.id, result: { value: { kind: 'foreground', exitCode: 0, stdout: { text: 'ok\n' }, stderr: { text: '' } } } }
          }
          return { callId: call.id, result: { content: [{ type: 'text', text: `content of ${args.file_path ?? args.path ?? ''}` }] } }
        }),
      }),
    },
  }
  const campaign = {
    ...campaignModule,
    createCampaign: async (...args) => {
      createCalls.push({ input: clone(args[1]), opts: args[2] })
      return campaignModule.createCampaign(...args)
    },
  }
  applyTeamworkCommand(ctx, {
    campaign,
    interview: interviewModule,
    dossier: { renderDossier: state => `dossier ${state.runId} ${state.status}` },
  })
  const root = { id: 'root-session' }
  const otherRoot = { id: 'other-root-session' }
  const call = (rawInput, agent = root) => definition.handler({ agent, rawInput, signal: new AbortController().signal })
  const dispose = async () => {
    for (const effect of effects.reverse()) {
      if (typeof effect === 'function') await effect()
    }
  }
  return { call, children, definition, createCalls, root, otherRoot, dispose }
}

test('command: no child before the human-typed confirm line, and a wrong line is rejected', async () => {
  const harness = commandHarness()
  const created = await harness.call('skip --mode swe-light add a feature\n@check node -e "process.exit(0)"')
  assert.equal(created.kind, 'success')
  assert.match(created.text, /Nothing runs until the human types this exact line/u)
  assert.equal(harness.children.length, 0)

  const match = created.text.match(/\/teamwork (confirm [^\n]+)/u)
  assert.ok(match, 'draft must show the exact confirmation line')
  const confirmLine = match[1]
  const runId = confirmLine.split(' ')[1]

  const wrong = await harness.call(`confirm ${runId} with a small change`)
  assert.equal(wrong.kind, 'error')
  assert.equal(harness.children.length, 0, 'a model-style paraphrase must not start any child')

  const confirmed = await harness.call(confirmLine)
  assert.equal(confirmed.kind, 'success', confirmed.text)
  assert.equal(harness.children.length, 3, 'implementer, reviewer and fresh auditor run')
  assert.match(confirmed.text, /Victory audit: passed/u)
})

test('command: an answer cannot move the draft workdir to another directory', async () => {
  const answers = {
    objective: 'Build a ledger',
    users: 'maintainers',
    restrictions: 'e',
    deliverables: 'src/ledger.js',
    constraints: 'no dependencies',
    acceptance: 'node -e "process.exit(0)"',
    route: 'swe-light',
  }
  const state = campaignModule.createCampaignState({
    mode: 'swe-light',
    cwd: '/tmp/teamwork-command',
    rootSessionId: 'root-session',
    runId: 'tw-seed-aaaaaa',
    confirmedCommand: 'node -e "process.exit(0)"',
    skipInterview: false,
    answers,
  })
  assert.equal(state.status, 'draft')
  const harness = commandHarness({ storageDomain: memoryStorageDomain({ [state.runId]: state }) })

  const rejected = await harness.call(`answer ${state.runId} workdir /tmp/other`)
  assert.equal(rejected.kind, 'error', rejected.text)
  assert.match(rejected.text, /WORKDIR_MISMATCH|@cwd \/tmp\/other|No answer accepted/u)
  assert.equal(harness.children.length, 0)

  if (process.platform !== 'win32') {
    const backslash = await harness.call(`answer ${state.runId} workdir /tmp/teamwork-command\\`)
    assert.equal(backslash.kind, 'error', backslash.text)
    assert.match(backslash.text, /WORKDIR_MISMATCH|@cwd \/tmp\/teamwork-command\\|No answer accepted/u)
    assert.equal(harness.children.length, 0)
  }

  const accepted = await harness.call(`answer ${state.runId} workdir /tmp/teamwork-link`)
  assert.equal(accepted.kind, 'success', accepted.text)
  assert.match(accepted.text, /Workdir: \/tmp\/teamwork-command/u)
  assert.ok(!/Workdir: \/tmp\/teamwork-link/u.test(accepted.text))
  assert.equal(harness.children.length, 0, 'answering never starts a child')
  await harness.dispose()
})

test('command: confirmation rejects a legacy draft workdir mismatch before any child starts', async () => {
  const state = campaignModule.createCampaignState({
    mode: 'swe-light',
    cwd: '/tmp/teamwork-command',
    rootSessionId: 'root-session',
    runId: 'tw-seed-bbbbbb',
    confirmedCommand: 'node -e "process.exit(0)"',
    skipInterview: true,
    answers: {
      objective: 'Build a ledger', users: 'maintainers', restrictions: 'e',
      deliverables: 'src/ledger.js', constraints: 'no dependencies',
      acceptance: 'node -e "process.exit(0)"', route: 'swe-light',
      workdir: '/tmp/teamwork-command',
    },
  })
  const draft = state.interview.draft
  const moved = {
    ...state,
    interview: {
      ...state.interview,
      answers: { ...state.interview.answers, workdir: '/tmp/other' },
      draft: { ...draft, workdir: '/tmp/other' },
    },
  }
  const harness = commandHarness({ storageDomain: memoryStorageDomain({ [state.runId]: moved }) })

  const rejected = await harness.call(draft.confirmLine)
  assert.equal(rejected.kind, 'error', rejected.text)
  assert.match(rejected.text, /WORKDIR_MISMATCH/u)
  assert.match(rejected.text, /@cwd \/tmp\/other/u)
  assert.equal(harness.children.length, 0, 'a legacy mismatch must not start a child')
  await harness.dispose()
})

test('command: a legacy draft spelled with an equivalent workdir confirms in the frozen cwd', async () => {
  const state = campaignModule.createCampaignState({
    mode: 'swe-light',
    cwd: '/tmp/teamwork-command',
    rootSessionId: 'root-session',
    runId: 'tw-seed-cccccc',
    confirmedCommand: 'node -e "process.exit(0)"',
    skipInterview: true,
    answers: {
      objective: 'Build a ledger', users: 'maintainers', restrictions: 'e',
      deliverables: 'src/ledger.js', constraints: 'no dependencies',
      acceptance: 'node -e "process.exit(0)"', route: 'swe-light',
      workdir: '/tmp/teamwork-command',
    },
  })
  const draft = state.interview.draft
  const aliased = {
    ...state,
    interview: {
      ...state.interview,
      answers: { ...state.interview.answers, workdir: '/tmp/teamwork-link' },
      draft: { ...draft, workdir: '/tmp/teamwork-link', answers: { ...draft.answers, workdir: '/tmp/teamwork-link' } },
    },
    spec: { ...state.spec, workdir: '/tmp/teamwork-link' },
  }
  const harness = commandHarness({ storageDomain: memoryStorageDomain({ [state.runId]: aliased }) })

  const normalized = await harness.call(draft.confirmLine)
  assert.equal(normalized.kind, 'error', normalized.text)
  assert.match(normalized.text, /Draft normalized/u)
  assert.match(normalized.text, /creation-time workspace \/tmp\/teamwork-command/u)
  assert.equal(harness.children.length, 0, 'the old token must not start a child')
  const canonicalLine = normalized.text.match(/\/teamwork (confirm [^\n]+)/u)?.[1]
  assert.ok(canonicalLine, 'the normalized confirmation line must be shown')

  const confirmed = await harness.call(canonicalLine)
  assert.equal(confirmed.kind, 'success', confirmed.text)
  assert.equal(harness.children.length, 3)
  await harness.dispose()
})

test('command: same cwd is mutually exclusive while a run is non-terminal', async () => {
  const harness = commandHarness()
  const first = await harness.call('skip --mode swe-light first run\n@check node -e "process.exit(0)"')
  assert.equal(first.kind, 'success', first.text)
  const second = await harness.call('skip --mode swe-light second run\n@check node -e "process.exit(0)"')
  assert.equal(second.kind, 'error')
  assert.match(second.text, /busy|already|active/u)
  assert.equal(harness.children.length, 0)
})

test('command: dossier is read-only and starts no child', async () => {
  const harness = commandHarness()
  await harness.call('skip --mode swe-light add a feature\n@check node -e "process.exit(0)"')
  const dossier = await harness.call('dossier')
  assert.equal(dossier.kind, 'success')
  assert.match(dossier.text, /^dossier tw-/u)
  assert.equal(harness.children.length, 0)
})


test('command: pause aborts the live child, persists paused, and resume re-dispatches it', async () => {
  const harness = commandHarness({ hangImplementerFirst: true })
  const created = await harness.call('skip --mode swe-light long task\n@check node -e "process.exit(0)"')
  const match = created.text.match(/\/teamwork (confirm [^\n]+)/u)
  assert.ok(match)
  const runId = match[1].split(' ')[1]

  const running = harness.call(match[1])
  for (let i = 0; i < 100 && harness.children.length === 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(harness.children.length, 1)

  const paused = await harness.call(`pause ${runId}`)
  assert.equal(paused.kind, 'success', paused.text)
  const tooEarly = await harness.call(`resume ${runId}`)
  assert.equal(tooEarly.kind, 'error')
  assert.match(tooEarly.text, /already starting|still stopping/u, 'resume must not flip state while the aborted pass is unwinding')
  const firstPass = await running
  assert.match(firstPass.text, /paused/iu)

  const resumed = await harness.call(`resume ${runId}`)
  assert.equal(resumed.kind, 'success', resumed.text)
  assert.match(resumed.text, /Victory audit: passed/u)
  assert.equal(harness.children.length, 4, 'aborted implementer plus retried implementer, reviewer, auditor')
})


test('command: simultaneous drafts for one canonical cwd create exactly one run', async () => {
  const harness = commandHarness()
  const [first, second] = await Promise.all([
    harness.call('skip --mode swe-light first\n@check true\n@cwd /tmp/teamwork-link'),
    harness.call('skip --mode swe-light second\n@check true\n@cwd /tmp/teamwork-command'),
  ])
  const kinds = [first.kind, second.kind].sort()
  assert.deepEqual(kinds, ['error', 'success'], `${first.text}\n---\n${second.text}`)
  assert.equal(harness.createCalls.length, 1, 'only one draft may be created')
  const failed = first.kind === 'error' ? first : second
  assert.match(failed.text, /already being created|already open|already active/iu)
  assert.equal(harness.children.length, 0)
})

test('command: @file inputs are forwarded to the persisted campaign specification', async () => {
  const harness = commandHarness()
  const created = await harness.call('skip --mode swe-light add tests\n@check true\n@file src/a.js\n@file test/a.test.js')
  assert.equal(created.kind, 'success', created.text)
  assert.deepEqual(harness.createCalls[0].input.files, ['src/a.js', 'test/a.test.js'])
})

test('command: implicit status, list and pause never adopt another root session run', async () => {
  const harness = commandHarness()
  const created = await harness.call('skip --mode swe-light private run\n@check true')
  const runId = created.text.match(/run (tw-[a-z0-9]+-[a-f0-9]+)/u)?.[1]
  assert.ok(runId)

  const status = await harness.call('status', harness.otherRoot)
  assert.equal(status.kind, 'error')
  assert.match(status.text, /No teamwork run is associated/u)
  assert.doesNotMatch(status.text, new RegExp(runId, 'u'))

  const list = await harness.call('list', harness.otherRoot)
  assert.equal(list.kind, 'success')
  assert.match(list.text, /No active teamwork run owned by this session/u)
  assert.doesNotMatch(list.text, new RegExp(runId, 'u'))

  const pause = await harness.call('pause', harness.otherRoot)
  assert.equal(pause.kind, 'error')
  assert.equal(harness.children.length, 0)

  const explicit = await harness.call(`status ${runId}`, harness.otherRoot)
  assert.equal(explicit.kind, 'error')
  assert.match(explicit.text, /belongs to another root session/u)
})

test('command: another root cannot pause or resume a live run', async () => {
  const harness = commandHarness({ hangImplementerFirst: true })
  const created = await harness.call('skip --mode swe-light live run\n@check true')
  const line = created.text.match(/\/teamwork (confirm [^\n]+)/u)[1]
  const runId = line.split(' ')[1]
  const running = harness.call(line)
  for (let i = 0; i < 100 && harness.children.length === 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(harness.children.length, 1)

  const foreignPause = await harness.call(`pause ${runId}`, harness.otherRoot)
  assert.equal(foreignPause.kind, 'error')
  assert.match(foreignPause.text, /belongs to another root session/u)
  assert.equal(harness.children.length, 1, 'the owner run must keep executing')

  const ownerPause = await harness.call(`pause ${runId}`)
  assert.equal(ownerPause.kind, 'success', ownerPause.text)
  const firstPass = await running
  assert.match(firstPass.text, /paused/iu)

  const foreignResume = await harness.call(`resume ${runId}`, harness.otherRoot)
  assert.equal(foreignResume.kind, 'error')
  assert.match(foreignResume.text, /belongs to another root session/u)

  const ownerResume = await harness.call(`resume ${runId}`)
  assert.equal(ownerResume.kind, 'success', ownerResume.text)
  assert.match(ownerResume.text, /Victory audit: passed/u)
})

test('command: two concurrent confirmations start one campaign pass', async () => {
  const harness = commandHarness()
  const created = await harness.call('skip --mode swe-light one run\n@check true')
  const line = created.text.match(/\/teamwork (confirm [^\n]+)/u)[1]
  const [first, second] = await Promise.all([harness.call(line), harness.call(line)])
  const kinds = [first.kind, second.kind].sort()
  assert.deepEqual(kinds, ['error', 'success'], `${first.text}\n---\n${second.text}`)
  assert.equal(harness.children.length, 3, 'one implementer, one reviewer and one auditor')
})

test('command: two concurrent resumes start one continuation pass', async () => {
  const harness = commandHarness({ hangImplementerFirst: true })
  const created = await harness.call('skip --mode swe-light slow run\n@check true')
  const line = created.text.match(/\/teamwork (confirm [^\n]+)/u)[1]
  const runId = line.split(' ')[1]
  const running = harness.call(line)
  for (let i = 0; i < 100 && harness.children.length === 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(harness.children.length, 1)
  const paused = await harness.call(`pause ${runId}`)
  assert.equal(paused.kind, 'success', paused.text)
  await running

  const [first, second] = await Promise.all([harness.call(`resume ${runId}`), harness.call(`resume ${runId}`)])
  const kinds = [first.kind, second.kind].sort()
  assert.deepEqual(kinds, ['error', 'success'], `${first.text}\n---\n${second.text}`)
  assert.equal(harness.children.length, 4, 'aborted implementer plus one resumed pass')
})

test('command: restart rebuilds the draft workspace index for no-argument status', async () => {
  const domain = memoryStorageDomain()
  const first = commandHarness({ storageDomain: domain })
  const created = await first.call('skip --mode swe-light surviving draft\n@check node -e "process.exit(0)"')
  assert.equal(created.kind, 'success', created.text)
  const runId = created.text.match(/run (tw-[a-z0-9-]+)/u)?.[1]
  assert.ok(runId)
  await first.dispose()
  assert.equal(first.children.length, 0)

  const second = commandHarness({ storageDomain: domain })
  const status = await second.call('status')
  assert.equal(status.kind, 'success', status.text)
  assert.match(status.text, new RegExp(runId, 'u'))
  assert.match(status.text, /awaiting-confirm/u)
  assert.match(status.text, /Awaiting the exact line: \/teamwork confirm /u)
  assert.equal(second.children.length, 0, 'status must never dispatch recovered drafts')

  const duplicate = await second.call('skip --mode swe-light another run\n@check true', second.otherRoot)
  assert.equal(duplicate.kind, 'error')
  assert.match(duplicate.text, /already open|already active|busy/u, 'another root must not start a second draft in a recovered workspace')
  assert.equal(second.children.length, 0)

  const foreign = await second.call('status', second.otherRoot)
  assert.equal(foreign.kind, 'error')
  assert.match(foreign.text, /No teamwork run is associated/u)
  await second.dispose()
})

test('command: restart pauses a persisted running state for manual recovery and dispatches nothing', async () => {
  const base = campaignModule.createCampaignState({
    mode: 'swe-light',
    runId: 'tw-recovery-abcdef',
    cwd: '/tmp/teamwork-command',
    rootSessionId: 'root-session',
    confirmedCommand: 'node -e "process.exit(0)"',
    originalRequest: 'long running task',
    skipInterview: true,
    answers: {
      objective: 'long running task',
      users: 'operator',
      restrictions: 'e',
      deliverables: 'code',
      constraints: 'none',
      acceptance: 'node -e "process.exit(0)"',
      route: 'swe-light',
      workdir: '/tmp/teamwork-command',
    },
  })
  const draft = base.interview.draft
  const confirmed = campaignModule.reduceEvent(base, {
    type: 'confirm',
    text: draft.confirmLine,
    token: draft.token,
    version: draft.version,
    source: 'manual-chat',
  })
  assert.equal(confirmed.state.status, 'running')
  const runId = confirmed.state.runId
  const domain = memoryStorageDomain({ [runId]: confirmed.state })

  const second = commandHarness({ storageDomain: domain })
  const status = await second.call('status')
  assert.equal(status.kind, 'success', status.text)
  assert.match(status.text, new RegExp(runId, 'u'))
  assert.match(status.text, /status paused/u)
  assert.match(status.text, /Recovery: this run was running/u)
  assert.match(status.text, /RESTART_REQUIRES_MANUAL|manual \/teamwork resume/u)
  assert.equal(second.children.length, 0, 'restart recovery must never re-dispatch the persisted running state')

  const explicit = await second.call(`status ${runId}`)
  assert.equal(explicit.kind, 'success', explicit.text)
  assert.match(explicit.text, /status paused/u)
  assert.equal(second.children.length, 0)
  await second.dispose()
})

test('command: restart does not resurrect done runs and successful runs release their lease', async () => {
  const domain = memoryStorageDomain()
  const first = commandHarness({ storageDomain: domain })
  const created = await first.call('skip --mode swe-light finished task\n@check node -e "process.exit(0)"')
  const match = created.text.match(/\/teamwork (confirm [^\n]+)/u)
  assert.ok(match)
  const runId = match[1].split(' ')[1]
  const confirmed = await first.call(match[1])
  assert.equal(confirmed.kind, 'success', confirmed.text)
  const afterRun = await first.call(`status ${runId}`)
  assert.equal(afterRun.kind, 'success', afterRun.text)
  assert.match(afterRun.text, /status done/u)
  assert.match(afterRun.text, /lease none/u, 'a finished pass must not leave the host lease behind')
  await first.dispose()

  const second = commandHarness({ storageDomain: domain })
  const status = await second.call('status')
  assert.equal(status.kind, 'error')
  assert.match(status.text, /No teamwork run is associated/u)
  assert.equal(second.children.length, 0, 'done runs are not recovered and never dispatch')
  await second.dispose()
})

test('command: startup recovery failure closes the store it opened', async () => {
  let closed = false
  const domain = memoryStorageDomain()
  const open = domain.open.bind(domain)
  domain.open = async spec => {
    const opened = await open(spec)
    const table = opened.table.bind(opened)
    const close = opened.close.bind(opened)
    return {
      table: () => {
        const runs = table()
        return { ...runs, entries: () => { throw new Error('recovery scan failed') } }
      },
      close: async () => { closed = true; await close() },
    }
  }
  const harness = commandHarness({ storageDomain: domain })
  const result = await harness.call('status')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /recovery scan failed/u)
  assert.equal(closed, true, 'a failed startup recovery must close the opened store')
  await harness.dispose()
})

test('command: summary shows the newest acceptance receipt, not an older success', async () => {
  const base = campaignModule.createCampaignState({
    mode: 'swe-light',
    runId: 'tw-receipt-abcdef',
    cwd: '/tmp/teamwork-command',
    rootSessionId: 'root-session',
    confirmedCommand: 'node -e "process.exit(0)"',
    originalRequest: 'receipt task',
    skipInterview: true,
    answers: {
      objective: 'receipt task',
      users: 'operator',
      restrictions: 'e',
      deliverables: 'code',
      constraints: 'none',
      acceptance: 'node -e "process.exit(0)"',
      route: 'swe-light',
      workdir: '/tmp/teamwork-command',
    },
  })
  const state = {
    ...base,
    status: 'done',
    evidence: { ...base.evidence, latest: { check: { command: 'node old-check.js', exitCode: 0, stdout: '', stderr: '' } } },
    audit: {
      ...base.audit,
      status: 'failed',
      evidence: { command: 'node new-audit.js', exitCode: 2, stdout: '', stderr: 'boom' },
    },
  }
  const harness = commandHarness({ storageDomain: memoryStorageDomain({ [state.runId]: state }) })
  const status = await harness.call(`status ${state.runId}`)
  assert.equal(status.kind, 'success', status.text)
  assert.match(status.text, /last acceptance: exit 2 — node new-audit\.js \(audited\)/u)
  assert.doesNotMatch(status.text, /last acceptance: exit 0 — node old-check\.js/u)
  await harness.dispose()
})

test('status prefers the audit acceptance evidence over an older successful check', () => {
  const state = {
    evidence: { latest: { check: { command: 'npm test', exitCode: 0, stdout: 'old', stderr: '' } } },
    audit: { evidence: { command: 'npm test', exitCode: 2, stdout: 'new', stderr: 'failed' } },
  }
  assert.match(acceptanceView(state), /exit 2/u)
  assert.doesNotMatch(acceptanceView(state), /exit 0/u)
  assert.match(acceptanceView({ evidence: state.evidence }), /exit 0/u)
})
