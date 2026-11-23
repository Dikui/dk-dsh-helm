import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { armReveal, revealPredecessor, observeRevealResult, BoostRevealError } from '../src/reveal.js'
import { apply, WORKER_ALLOWED_TOOLS, REVIEWER_ALLOWED_TOOLS } from '../src/policy.js'

const here = dirname(fileURLToPath(import.meta.url))
const patch = await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8')

let sequence = 0
function agentKey(label) {
  sequence += 1
  return `boost-test-${label}-${sequence}`
}

function policyContext(service, events = []) {
  return {
    tools: service,
    on(name, handler) {
      events.push({ name, handler })
      return () => {}
    },
  }
}

function toolsService(globals = [], overrides = {}) {
  const calls = { definitions: [], register: [], restrict: [], guard: [] }
  const service = {
    definitions(scope) {
      calls.definitions.push(scope)
      return globals.map(name => ({ name }))
    },
    register(definition) {
      calls.register.push(definition)
      return overrides.register ? overrides.register(definition) : () => {}
    },
    restrict(filter) {
      calls.restrict.push(filter)
      return overrides.restrict ? overrides.restrict(filter) : () => {}
    },
    guard(guard) {
      calls.guard.push(guard)
      return overrides.guard ? overrides.guard(guard) : () => {}
    },
  }
  return { service, calls }
}

function applyWith(role, globals, overrides, events = []) {
  const { service, calls } = toolsService(globals, overrides)
  apply(policyContext(service, events), { role })
  return calls
}

function assertRevealError(code) {
  return error => error instanceof BoostRevealError && error.code === code
}

test('reveal: only the exact armed child can obtain the predecessor report', () => {
  const child = agentKey('armed')
  const other = agentKey('other')
  const seen = []
  const dispose = armReveal(child, verdict => {
    seen.push(verdict)
    return 'predecessor report'
  })

  assert.equal(revealPredecessor(child, 'my initial verdict'), 'predecessor report')
  assert.deepEqual(seen, ['my initial verdict'])

  assert.throws(() => revealPredecessor(other, 'my initial verdict'), assertRevealError('REVEAL_NOT_ARMED'))
  assert.deepEqual(seen, ['my initial verdict'])
  dispose()
})

test('reveal: rejects empty initial verdicts without calling the armed function', () => {
  const child = agentKey('empty')
  let calls = 0
  const dispose = armReveal(child, () => {
    calls += 1
    return 'report'
  })

  for (const value of ['', '   ', '\n\t', undefined, null, 0, {}]) {
    assert.throws(() => revealPredecessor(child, value), assertRevealError('EMPTY_INITIAL_VERDICT'))
  }
  assert.equal(calls, 0)
  dispose()
})

test('reveal: disposer is idempotent and does not remove a later arm', () => {
  const child = agentKey('dispose')
  const first = armReveal(child, () => 'first')
  first()
  first()

  const second = armReveal(child, () => 'second')
  first()
  assert.equal(revealPredecessor(child, 'verdict'), 'second')
  second()
  assert.throws(() => revealPredecessor(child, 'verdict'), assertRevealError('REVEAL_NOT_ARMED'))
})

test('reveal: refuses duplicate arms for a live child', () => {
  const child = agentKey('duplicate')
  const dispose = armReveal(child, () => 'report')
  assert.throws(() => armReveal(child, () => 'other'), assertRevealError('REVEAL_ALREADY_ARMED'))
  dispose()
})

test('reveal: preserves the armed function error and validates its result', () => {
  const closed = agentKey('closed')
  const boom = new Error('reveal after end')
  boom.code = 'REVEAL_AFTER_END'
  const disposeClosed = armReveal(closed, () => {
    throw boom
  })
  assert.throws(() => revealPredecessor(closed, 'verdict'), error => error === boom)
  disposeClosed()

  const invalid = agentKey('invalid')
  const disposeInvalid = armReveal(invalid, () => 42)
  assert.throws(() => revealPredecessor(invalid, 'verdict'), assertRevealError('INVALID_REVEAL_RESULT'))
  disposeInvalid()
})

test('reveal: keeps the callback armed after a successful reveal', () => {
  const child = agentKey('repeat')
  let calls = 0
  const dispose = armReveal(child, () => `report-${++calls}`)
  assert.equal(revealPredecessor(child, 'verdict'), 'report-1')
  assert.equal(revealPredecessor(child, 'verdict'), 'report-2')
  dispose()
})

// Regression: only a pure protocol call may treat its synchronous return as
// delivery; a Host tool execution must present its exact execution token.
test('reveal: a provided execution without a Host token fails closed', () => {
  const child = agentKey('token-required')
  let calls = 0
  const dispose = armReveal(child, () => {
    calls += 1
    return 'report'
  })
  const base = { name: 'boost_reveal', agent: { id: child } }

  for (const [label, execution] of [
    ['missing token', base],
    ['null token', { ...base, token: null }],
    ['string token', { ...base, token: 'not-a-symbol' }],
  ]) {
    assert.throws(
      () => revealPredecessor(child, 'verdict', execution),
      assertRevealError('REVEAL_EXECUTION_TOKEN_REQUIRED'),
      label,
    )
  }
  assert.throws(
    () => revealPredecessor(child, 'verdict', null),
    assertRevealError('INVALID_REVEAL_EXECUTION'),
  )
  assert.throws(
    () => revealPredecessor(child, 'verdict', 42),
    assertRevealError('INVALID_REVEAL_EXECUTION'),
  )
  assert.throws(
    () => revealPredecessor(child, 'verdict', undefined),
    assertRevealError('INVALID_REVEAL_EXECUTION'),
    'an explicitly absent execution argument is not a direct protocol call',
  )
  assert.equal(calls, 0)

  // Only omission of the execution argument itself keeps the synchronous
  // pure-protocol behavior.
  assert.equal(revealPredecessor(child, 'verdict'), 'report')
  assert.equal(calls, 1)
  dispose()
})

test('reveal: forwards the final isError unchanged so a missing flag is not success', () => {
  const child = agentKey('is-error-faithful')
  const observations = []
  const revealFn = () => 'report'
  revealFn.confirmDelivery = observation => {
    observations.push(observation)
    return observation.isError === false
  }
  const dispose = armReveal(child, revealFn)
  const exec = { name: 'boost_reveal', agent: { id: child }, token: Symbol('faithful') }

  assert.equal(revealPredecessor(child, 'verdict', exec), 'report')
  const content = [{ type: 'text', text: 'report' }]
  assert.equal(observeRevealResult(exec, { content }), false)
  assert.equal(observations.length, 1)
  assert.equal(observations[0].isError, undefined)
  assert.deepEqual(observations[0].content, content)
  dispose()
})

test('reveal: defers delivery for an exact execution and only that result confirms it', () => {
  const child = agentKey('delivery')
  const other = agentKey('delivery-other')
  const options = []
  const confirmations = []
  const revealFn = (verdict, received) => {
    options.push(received)
    return `predecessor:${verdict}`
  }
  revealFn.confirmDelivery = observation => {
    confirmations.push(observation)
    return observation.isError === false
      && observation.content?.[0]?.type === 'text'
      && observation.content[0].text === 'predecessor:locked'
  }
  const dispose = armReveal(child, revealFn)
  const token = Symbol('token')
  const exec = { name: 'boost_reveal', agent: { id: child }, token }
  assert.equal(revealPredecessor(child, 'locked', exec), 'predecessor:locked')
  assert.deepEqual(options, [{ deferDelivery: true }])

  const delivered = { isError: false, content: [{ type: 'text', text: 'predecessor:locked' }] }
  assert.equal(observeRevealResult({ ...exec, agent: { id: other } }, delivered), false)
  assert.equal(observeRevealResult({ ...exec, name: 'other' }, delivered), false)
  assert.equal(
    observeRevealResult({ name: 'boost_reveal', agent: { id: child }, token: Symbol('other') }, delivered),
    false,
  )
  assert.deepEqual(confirmations, [])

  assert.equal(observeRevealResult(exec, delivered), true)
  assert.equal(confirmations.length, 1)
  assert.equal(confirmations[0].agentId, child)
  assert.equal(confirmations[0].token, token)
  assert.equal(confirmations[0].isError, false)
  assert.deepEqual(confirmations[0].content, delivered.content)

  // A duplicate observation of the same execution is not a second receipt.
  assert.equal(observeRevealResult(exec, delivered), false)
  assert.equal(confirmations.length, 1)
  dispose()
})

test('reveal: direct calls do not defer, and disposing clears a pending delivery', () => {
  const child = agentKey('delivery-dispose')
  const options = []
  const confirmations = []
  const revealFn = (verdict, received) => {
    options.push(received)
    return `predecessor:${verdict}`
  }
  revealFn.confirmDelivery = observation => {
    confirmations.push(observation)
    return true
  }
  const dispose = armReveal(child, revealFn)

  assert.equal(revealPredecessor(child, 'direct'), 'predecessor:direct')
  assert.deepEqual(options, [undefined])

  const token = Symbol('pending')
  const exec = { name: 'boost_reveal', agent: { id: child }, token }
  assert.equal(revealPredecessor(child, 'deferred', exec), 'predecessor:deferred')
  assert.deepEqual(options, [undefined, { deferDelivery: true }])

  dispose()
  assert.equal(observeRevealResult(exec, { isError: false, content: [{ type: 'text', text: 'predecessor:deferred' }] }), false)
  assert.deepEqual(confirmations, [])
})

test('reveal: refuses two pending deliveries for one execution token', () => {
  const child = agentKey('delivery-duplicate')
  let calls = 0
  const revealFn = () => {
    calls += 1
    return 'report'
  }
  revealFn.confirmDelivery = () => true
  const dispose = armReveal(child, revealFn)
  const token = Symbol('duplicate')
  const exec = { name: 'boost_reveal', agent: { id: child }, token }

  assert.equal(revealPredecessor(child, 'first', exec), 'report')
  assert.throws(() => revealPredecessor(child, 'second', exec), assertRevealError('REVEAL_ALREADY_RECORDED'))
  assert.equal(calls, 1)
  assert.equal(observeRevealResult(exec, { isError: false, content: [{ type: 'text', text: 'report' }] }), true)
  dispose()
})

test('policy worker: denies every non-allowlisted global and guards the allowlist', () => {
  const events = []
  const calls = applyWith('worker', ['run_code', 'some_global', 'read', 'bash'], {}, events)

  assert.deepEqual(events, [])
  assert.equal(calls.register.length, 0)
  assert.equal(calls.definitions.length, 1)
  assert.equal(calls.definitions[0], undefined)
  assert.equal(calls.restrict.length, 1)
  assert.deepEqual([...calls.restrict[0].deny].sort(), ['some_global'])
  assert.equal(calls.guard.length, 1)

  const guard = calls.guard[0]
  for (const name of WORKER_ALLOWED_TOOLS) {
    assert.equal(guard({ name, agent: { id: 'worker-agent' } }), undefined, name)
  }
  for (const name of ['run_code', 'subagent', 'read_image', 'apply_patch', 'write_file']) {
    assert.match(guard({ name, agent: { id: 'worker-agent' } }), /not allowed/i, name)
  }
  assert.match(guard({ name: 'read' }), /calling agent/i)
})

test('policy reviewer: registers only boost_reveal and serves the predecessor report', async () => {
  const child = agentKey('reviewer')
  const { service, calls } = toolsService(['run_code', 'some_global'], {})
  const events = []
  apply(policyContext(service, events), { role: 'reviewer' })
  assert.deepEqual(events.map(event => event.name), ['tools/result'])

  assert.equal(calls.register.length, 1)
  const definition = calls.register[0]
  assert.equal(definition.name, 'boost_reveal')
  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.parameters.required, ['initialVerdict'])
  assert.equal(definition.parameters.properties.initialVerdict.type, 'string')
  assert.deepEqual(definition.output.schema, { type: 'string' })
  assert.equal(typeof definition.output.render, 'function')

  const dispose = armReveal(child, verdict => `predecessor:${verdict}`)
  const report = await definition.execute(
    { initialVerdict: 'looks good' },
    { name: 'boost_reveal', agent: { id: child }, token: Symbol('policy-review') },
  )
  assert.equal(report, 'predecessor:looks good')
  assert.deepEqual(definition.output.render(null, report), [{ type: 'text', text: 'predecessor:looks good' }])

  const guard = calls.guard[0]
  assert.equal(guard({ name: 'boost_reveal', agent: { id: child } }), undefined)
  assert.match(guard({ name: 'read', agent: { id: child } }), /not allowed/i)
  assert.match(guard({ name: 'run_code', agent: { id: child } }), /not allowed/i)
  assert.match(guard({ name: 'boost_reveal' }), /calling agent/i)
  assert.deepEqual(calls.restrict[0].deny, ['some_global'])
  assert.deepEqual(REVIEWER_ALLOWED_TOOLS, ['boost_reveal'])

  await assert.rejects(
    definition.execute({ initialVerdict: '   ' }, { agent: { id: child } }),
    assertRevealError('EMPTY_INITIAL_VERDICT'),
  )
  await assert.rejects(
    definition.execute({}, { agent: { id: child } }),
    assertRevealError('EMPTY_INITIAL_VERDICT'),
  )
  await assert.rejects(
    definition.execute({ initialVerdict: 'x' }, { agent: { id: agentKey('other') } }),
    assertRevealError('REVEAL_NOT_ARMED'),
  )
  await assert.rejects(
    definition.execute({ initialVerdict: 'x' }, {}),
    assertRevealError('REVEAL_CALLER_REQUIRED'),
  )
  dispose()
})

test('policy reviewer: confirms delivery through the tools/result observer for that execution', async () => {
  const child = agentKey('reviewer-delivery')
  const { service, calls } = toolsService(['some_global'], {})
  const events = []
  apply(policyContext(service, events), { role: 'reviewer' })
  assert.deepEqual(events.map(event => event.name), ['tools/result'])

  const confirmations = []
  const revealFn = (verdict, options) => {
    assert.deepEqual(options, { deferDelivery: true })
    return `predecessor:${verdict}`
  }
  revealFn.confirmDelivery = observation => {
    confirmations.push(observation)
    return observation.isError === false
  }
  const dispose = armReveal(child, revealFn)
  const token = Symbol('policy-token')
  const exec = { name: 'boost_reveal', agent: { id: child }, token }
  const definition = calls.register[0]

  assert.equal(await definition.execute({ initialVerdict: 'locked' }, exec), 'predecessor:locked')
  assert.deepEqual(confirmations, [])

  events[0].handler(exec, { isError: false, content: [{ type: 'text', text: 'predecessor:locked' }] })
  assert.equal(confirmations.length, 1)
  assert.equal(confirmations[0].agentId, child)
  assert.equal(confirmations[0].token, token)
  assert.equal(confirmations[0].isError, false)
  assert.deepEqual(confirmations[0].content, [{ type: 'text', text: 'predecessor:locked' }])

  events[0].handler(exec, { isError: false, content: [{ type: 'text', text: 'predecessor:locked' }] })
  assert.equal(confirmations.length, 1)
  dispose()
})

test('policy reviewer: a tool call without an execution token never claims delivery', async () => {
  const child = agentKey('reviewer-token')
  const { service, calls } = toolsService([])
  apply(policyContext(service), { role: 'reviewer' })
  let reveals = 0
  const dispose = armReveal(child, () => {
    reveals += 1
    return 'report'
  })

  await assert.rejects(
    calls.register[0].execute(
      { initialVerdict: 'locked' },
      { name: 'boost_reveal', agent: { id: child } },
    ),
    assertRevealError('REVEAL_EXECUTION_TOKEN_REQUIRED'),
  )
  await assert.rejects(
    calls.register[0].execute({ initialVerdict: 'locked' }, undefined),
    assertRevealError('REVEAL_CALLER_REQUIRED'),
    'a Host tool call without any execution context never claims delivery',
  )
  assert.equal(reveals, 0)
  dispose()
})

test('policy reviewer: refuses to start when the tools/result observer is unavailable', () => {
  const { service, calls } = toolsService(['some_global'])
  assert.throws(
    () => apply({ tools: service }, { role: 'reviewer' }),
    /could not install its tool boundary.*tools\/result.*Refusing to start/is,
  )
  assert.equal(calls.register.length, 0)
  assert.equal(calls.restrict.length, 0)
  assert.equal(calls.guard.length, 0)
})

test('policy: rejects an unknown or missing role before installing anything', () => {
  for (const config of [undefined, null, {}, { role: 'admin' }, { role: '' }]) {
    const { service, calls } = toolsService(['some_global'])
    assert.throws(() => apply({ tools: service }, config), /boost-role: config\.role/i)
    assert.equal(calls.register.length, 0)
    assert.equal(calls.restrict.length, 0)
    assert.equal(calls.guard.length, 0)
  }
  assert.throws(() => apply({}, { role: 'worker' }), /tools service/i)
})

test('policy: installation failures refuse to start and roll back partial installs', () => {
  const registerFailure = toolsService(['some_global'], {
    register() {
      throw new Error('duplicate tool')
    },
  })
  assert.throws(
    () => apply(policyContext(registerFailure.service), { role: 'reviewer' }),
    /Refusing to start \/boost reviewer with broader permissions.*integrity/i,
  )
  assert.equal(registerFailure.calls.restrict.length, 0)
  assert.equal(registerFailure.calls.guard.length, 0)

  let restrictRolledBack = 0
  const restrictFailure = toolsService(['some_global'], {
    restrict() {
      throw new Error('unknown global')
    },
  })
  assert.throws(
    () => apply({ tools: restrictFailure.service }, { role: 'worker' }),
    /Refusing to start \/boost worker with broader permissions.*integrity/i,
  )
  assert.equal(restrictFailure.calls.guard.length, 0)

  const guardFailure = toolsService(['some_global'], {
    restrict() {
      return () => {
        restrictRolledBack += 1
      }
    },
    guard() {
      throw new Error('guard rejected')
    },
  })
  assert.throws(
    () => apply({ tools: guardFailure.service }, { role: 'worker' }),
    /Refusing to start \/boost worker with broader permissions.*integrity/i,
  )
  assert.equal(restrictRolledBack, 1)
})

test('patch: declares the host command and both isolated role presets', () => {
  const workerAt = patch.indexOf('preset-dk-boost-worker')
  const reviewerAt = patch.indexOf('preset-dk-boost-reviewer')
  assert.ok(workerAt > 0, 'worker preset row is present')
  assert.ok(reviewerAt > workerAt, 'reviewer preset row follows the worker preset')
  assert.equal(patch.indexOf('preset-dk-boost-reviewer', reviewerAt + 1), -1, 'reviewer preset is last')

  const host = patch.slice(0, workerAt)
  assert.match(host, /^\s*-\s*id:\s*dk-boost-command\s*$/m)
  assert.match(host, /name:\s*'@local\/dk-dsh-boost'\s*$/m)

  const worker = patch.slice(workerAt, reviewerAt)
  assert.match(worker, /name:\s*'@deepseek-ai\/dsh-agent-preset'/)
  assert.match(worker, /id:\s*dk-boost-worker/)
  assert.match(worker, /name:\s*'@deepseek-ai\/dsh-tool-executor-native'/)
  assert.match(worker, /name:\s*'@deepseek-ai\/dsh-tool-fs'/)
  assert.match(worker, /name:\s*'@deepseek-ai\/dsh-tool-fs-search'/)
  assert.match(worker, /name:\s*'@deepseek-ai\/dsh-tool-bash'/)
  assert.match(worker, /name:\s*'@local\/dk-dsh-boost\/policy'/)
  assert.match(worker, /role:\s*worker/)
  assert.doesNotMatch(worker, /dsh-tool-subagent|dsh-tool-web|dsh-tool-session|dsh-tool-goal|dsh-tool-skill/)
  assert.doesNotMatch(worker, /readImage:\s*true|applyPatch:\s*true/)

  const reviewer = patch.slice(reviewerAt)
  assert.match(reviewer, /name:\s*'@deepseek-ai\/dsh-agent-preset'/)
  assert.match(reviewer, /id:\s*dk-boost-reviewer/)
  assert.match(reviewer, /name:\s*'@deepseek-ai\/dsh-tool-executor-native'/)
  assert.match(reviewer, /name:\s*'@local\/dk-dsh-boost\/policy'/)
  assert.match(reviewer, /role:\s*reviewer/)
  assert.doesNotMatch(
    reviewer,
    /dsh-tool-fs|dsh-tool-bash|dsh-tool-subagent|dsh-tool-web|dsh-tool-session|dsh-tool-goal|dsh-tool-skill|dsh-tool-ask-user|dsh-tool-todo/,
  )
  assert.doesNotMatch(reviewer, /predecessor report supplied in your prompt/)
  assert.match(reviewer, /After\s+the call succeeds, use the predecessor worker report/)
})
