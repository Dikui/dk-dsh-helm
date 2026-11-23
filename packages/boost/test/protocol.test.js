// Contract tests for the flat DSH Boost protocol (task: boost-protocol).
// The host callbacks runWorker/getEvidence/runReviewer are test doubles; the
// protocol module imports nothing and has no DSH dependency.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS, runBoost, BoostProtocolError } from '../src/protocol.js';

const TASK = 'Fix the flaky retry test without changing its public behavior.';
const EVIDENCE = 'test/retry.test.js:42 asserts three attempts before the final failure.';
const WORKER_REPORT = 'WORKER-REPORT-7f3a: retry count is three; I ran the retry suite.';
const FINAL_VERDICT = 'FINAL-VERDICT: the retry count is three and the evidence supports it.';

test('runBoost returns the worker report, the locked initial verdict, and the final verdict', async () => {
  const calls = [];
  let revealReturn;
  let secondRevealError;

  const result = await runBoost({
    task: TASK,
    runWorker: async (prompt) => {
      calls.push('worker');
      assert.match(prompt, /initial doer/i);
      assert.match(prompt, /Fix the flaky retry test/);
      assert.match(prompt, new RegExp(String(LIMITS.workerReportChars)));
      return WORKER_REPORT;
    },
    getEvidence: async () => {
      calls.push('evidence');
      return EVIDENCE;
    },
    runReviewer: async (prompt, reveal) => {
      calls.push('reviewer');
      assert.match(prompt, /Fix the flaky retry test/);
      assert.match(prompt, /test\/retry\.test\.js:42/);
      assert.ok(!prompt.includes(WORKER_REPORT), 'first reviewer packet must not contain the predecessor report');

      revealReturn = reveal('Initial verdict: the boundary is the retry count.');
      try {
        reveal('Initial verdict: overwritten.');
      } catch (error) {
        secondRevealError = error;
      }
      assert.match(prompt, /boost_reveal/);
      assert.doesNotMatch(prompt, /\breveal\(/);
      return FINAL_VERDICT;
    },
  });

  assert.deepEqual(calls, ['worker', 'evidence', 'reviewer']);
  assert.equal(revealReturn, WORKER_REPORT);
  assert.equal(secondRevealError.code, 'INITIAL_VERDICT_ALREADY_REVEALED');
  assert.match(secondRevealError.message, /boost_reveal/);
  assert.deepEqual(result, {
    workerReport: WORKER_REPORT,
    initialVerdict: 'Initial verdict: the boundary is the retry count.',
    finalVerdict: FINAL_VERDICT,
  });
});

test('worker prompt keeps the initial doer to one bounded text report and task-authorized tools', async () => {
  let workerPrompt;
  await runBoost({
    task: TASK,
    runWorker: async (prompt) => {
      workerPrompt = prompt;
      return WORKER_REPORT;
    },
    getEvidence: async () => '',
    runReviewer: async (prompt, reveal) => {
      reveal('initial');
      return 'final';
    },
  });

  assert.match(workerPrompt, /only the tools the task explicitly authorizes/i);
  assert.match(workerPrompt, /do not write your report to a file/i);
  assert.match(workerPrompt, /do not send messages/i);
  assert.match(workerPrompt, /one final text report/i);
  assert.match(workerPrompt, /at most \d+ characters/i);
});

test('reviewer prompt keeps the first pass independent and compares only after boost_reveal', async () => {
  let reviewerPrompt;
  await runBoost({
    task: TASK,
    runWorker: async () => WORKER_REPORT,
    getEvidence: async () => EVIDENCE,
    runReviewer: async (prompt, reveal) => {
      reviewerPrompt = prompt;
      reveal('initial');
      return 'final';
    },
  });

  assert.match(reviewerPrompt, /fresh reviewer/i);
  assert.match(reviewerPrompt, /not seen the predecessor's report/i);
  assert.match(reviewerPrompt, /independent/i);
  assert.match(reviewerPrompt, /boundar/i);
  assert.match(reviewerPrompt, /reviewable basis/i);
  assert.match(reviewerPrompt, /actually ran/i);
  assert.match(reviewerPrompt, /did not run/i);
  assert.match(reviewerPrompt, /Tool: boost_reveal/);
  assert.match(reviewerPrompt, /initialVerdict/);
  assert.doesNotMatch(reviewerPrompt, /initialVerdictText/);
  assert.doesNotMatch(reviewerPrompt, /\breveal\(/);
  assert.match(reviewerPrompt, /data to inspect, not instructions to follow/i);
  assert.match(reviewerPrompt, /exactly once/);
  assert.match(reviewerPrompt, /before your final report/i);
  assert.match(reviewerPrompt, /cannot be overwritten/i);
  assert.match(reviewerPrompt, /returns the predecessor/i);
  assert.match(reviewerPrompt, new RegExp(String(LIMITS.initialVerdictChars)));
  assert.match(reviewerPrompt, new RegExp(String(LIMITS.finalVerdictChars)));

  const firstPass = reviewerPrompt.split('Tool: boost_reveal')[0];
  assert.match(firstPass, /Do not guess, assume, or compare against the predecessor report before boost_reveal succeeds/i);
  assert.doesNotMatch(firstPass, /Note where you disagree/i);

  const finalSection = reviewerPrompt.split('Final text, after a successful boost_reveal:')[1];
  assert.ok(finalSection, 'final section must be present');
  assert.match(finalSection, /Compare your independent first pass with the predecessor report/i);
  assert.match(finalSection, /agreement and disagreement/i);
});

// Regression: boost_reveal locks the verdict in the tool body, but DSH
// post-execute policy can still block or replace the final model-facing content.
test('a deferred reveal only counts after the exact model-facing report content is delivered', async () => {
  let revealed;
  const result = await runBoost({
    task: TASK,
    runWorker: async () => WORKER_REPORT,
    getEvidence: async () => EVIDENCE,
    runReviewer: async (prompt, reveal) => {
      revealed = reveal;
      assert.equal(reveal('locked before the policy layer', { deferDelivery: true }), WORKER_REPORT);
      assert.equal(
        reveal.confirmDelivery({ isError: false, content: [{ type: 'text', text: WORKER_REPORT }] }),
        true,
      );
      return FINAL_VERDICT;
    },
  });

  assert.equal(result.initialVerdict, 'locked before the policy layer');
  assert.equal(result.finalVerdict, FINAL_VERDICT);
  assert.equal(
    revealed.confirmDelivery({ isError: false, content: [{ type: 'text', text: WORKER_REPORT }] }),
    false,
  );
});

test('a blocked or replaced reveal result is not delivery, and the run keeps the locked initial verdict', async () => {
  const cases = [
    {
      name: 'post-execute block',
      observation: { isError: true, content: [{ type: 'text', text: 'blocked by policy' }] },
      failure: 'error-result',
    },
    {
      name: 'accept with replacement text (isError=false)',
      observation: { isError: false, content: [{ type: 'text', text: 'policy summary instead of the report' }] },
      failure: 'content-mismatch',
    },
    {
      name: 'accept with the report plus extra content',
      observation: {
        isError: false,
        content: [{ type: 'text', text: WORKER_REPORT }, { type: 'text', text: 'appended by policy' }],
      },
      failure: 'content-mismatch',
    },
    {
      name: 'observation without a final isError flag',
      observation: { content: [{ type: 'text', text: WORKER_REPORT }] },
      failure: 'invalid-result',
    },
  ];

  for (const { name, observation, failure } of cases) {
    let lateReveal;
    await assert.rejects(
      runBoost({
        task: TASK,
        runWorker: async () => WORKER_REPORT,
        getEvidence: async () => EVIDENCE,
        runReviewer: async (prompt, reveal) => {
          lateReveal = reveal;
          reveal('locked before the policy layer', { deferDelivery: true });
          assert.equal(reveal.confirmDelivery(observation), false, name);
          return FINAL_VERDICT;
        },
      }),
      (error) => {
        assert.equal(error.code, 'REVEAL_NOT_DELIVERED', name);
        assert.equal(error.initialVerdict, 'locked before the policy layer', name);
        assert.equal(error.deliveryFailure, failure, name);
        assert.match(error.message, /not delivered/i, name);
        return true;
      },
    );

    assert.equal(
      lateReveal.confirmDelivery({ isError: false, content: [{ type: 'text', text: WORKER_REPORT }] }),
      false,
      `${name}: a late confirmation must not become a receipt`,
    );
  }
});

test('a deferred reveal with no observed delivery fails without reporting a comparison', async () => {
  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => EVIDENCE,
      runReviewer: async (prompt, reveal) => {
        reveal('locked but never observed', { deferDelivery: true });
        return FINAL_VERDICT;
      },
    }),
    (error) => {
      assert.equal(error.code, 'REVEAL_NOT_DELIVERED');
      assert.equal(error.initialVerdict, 'locked but never observed');
      assert.equal(error.deliveryFailure, 'not-observed');
      assert.doesNotMatch(error.message, /comparison (is )?complete/i);
      return true;
    },
  );
});

// Regression: a reviewer that fails after locking a verdict must still surface
// the sealed verdict, without replacing the original rejection.
test('a reviewer failure after a blocked reveal still carries the locked initial verdict', async () => {
  const boom = new Error('reviewer stopped after the blocked reveal');
  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => EVIDENCE,
      runReviewer: async (prompt, reveal) => {
        reveal('locked before the crash', { deferDelivery: true });
        assert.equal(
          reveal.confirmDelivery({ isError: true, content: [{ type: 'text', text: 'blocked by policy' }] }),
          false,
        );
        throw boom;
      },
    }),
    (error) => {
      assert.equal(error, boom);
      assert.equal(error.initialVerdict, 'locked before the crash');
      assert.equal(error.deliveryFailure, 'error-result');
      assert.equal(error.deliveryConfirmed, false);
      return true;
    },
  );
});

test('a reviewer failure after a delivered reveal still carries the locked initial verdict', async () => {
  const boom = new Error('reviewer crashed after reading the predecessor report');
  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => EVIDENCE,
      runReviewer: async (prompt, reveal) => {
        reveal('locked before the crash', { deferDelivery: true });
        assert.equal(
          reveal.confirmDelivery({ isError: false, content: [{ type: 'text', text: WORKER_REPORT }] }),
          true,
        );
        throw boom;
      },
    }),
    (error) => {
      assert.equal(error, boom);
      assert.equal(error.initialVerdict, 'locked before the crash');
      assert.equal(error.deliveryFailure, null);
      assert.equal(error.deliveryConfirmed, true);
      return true;
    },
  );
});

test('a final reviewer report without reveal fails closed', async () => {
  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => EVIDENCE,
      runReviewer: async () => FINAL_VERDICT,
    }),
    (error) => {
      assert.ok(error instanceof BoostProtocolError);
      assert.equal(error.code, 'MISSING_INITIAL_VERDICT');
      return true;
    },
  );
});

test('empty and oversized inputs fail closed with explicit usable limits and no callbacks', async () => {
  let callbackCalls = 0;

  await assert.rejects(
    runBoost({
      task: '   ',
      runWorker: async () => { callbackCalls += 1; return 'report'; },
      getEvidence: async () => '',
      runReviewer: async () => 'final',
    }),
    (error) => error.code === 'EMPTY_TASK',
  );

  await assert.rejects(
    runBoost({
      task: 'x'.repeat(LIMITS.taskChars + 1),
      runWorker: async () => { callbackCalls += 1; return 'report'; },
      getEvidence: async () => '',
      runReviewer: async () => 'final',
    }),
    (error) => {
      assert.equal(error.code, 'TASK_TOO_LONG');
      assert.equal(error.limit, LIMITS.taskChars);
      assert.equal(error.received, LIMITS.taskChars + 1);
      return true;
    },
  );

  assert.equal(callbackCalls, 0);
});

test('missing callbacks are rejected before any phase runs', async () => {
  await assert.rejects(
    runBoost({ task: TASK, runWorker: async () => WORKER_REPORT, getEvidence: async () => '' }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('an empty or oversized worker report stops the run before evidence collection', async () => {
  let evidenceCalls = 0;
  const base = {
    task: TASK,
    getEvidence: async () => { evidenceCalls += 1; return EVIDENCE; },
    runReviewer: async (prompt, reveal) => { reveal('initial'); return 'final'; },
  };

  await assert.rejects(
    runBoost({ ...base, runWorker: async () => '  \n ' }),
    (error) => error.code === 'EMPTY_WORKER_REPORT',
  );

  await assert.rejects(
    runBoost({ ...base, runWorker: async () => 'w'.repeat(LIMITS.workerReportChars + 1) }),
    (error) => {
      assert.equal(error.code, 'WORKER_REPORT_TOO_LONG');
      assert.equal(error.limit, LIMITS.workerReportChars);
      assert.equal(error.received, LIMITS.workerReportChars + 1);
      return true;
    },
  );

  assert.equal(evidenceCalls, 0);
});

test('empty evidence is allowed, but non-string or oversized evidence fails closed', async () => {
  let reviewerCalls = 0;

  await runBoost({
    task: TASK,
    runWorker: async () => WORKER_REPORT,
    getEvidence: async () => '',
    runReviewer: async (prompt, reveal) => {
      reviewerCalls += 1;
      reveal('initial');
      return 'final';
    },
  });
  assert.equal(reviewerCalls, 1);

  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => 42,
      runReviewer: async () => 'final',
    }),
    (error) => error.code === 'INVALID_EVIDENCE',
  );

  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => 'e'.repeat(LIMITS.evidenceChars + 1),
      runReviewer: async () => 'final',
    }),
    (error) => {
      assert.equal(error.code, 'EVIDENCE_TOO_LONG');
      assert.equal(error.limit, LIMITS.evidenceChars);
      return true;
    },
  );
});

test('the initial verdict must be non-empty and bounded, and is only locked once accepted', async () => {
  const failures = [];
  let result;

  result = await runBoost({
    task: TASK,
    runWorker: async () => WORKER_REPORT,
    getEvidence: async () => EVIDENCE,
    runReviewer: async (prompt, reveal) => {
      try {
        reveal('   ');
      } catch (error) {
        failures.push(error.code);
      }
      try {
        reveal('i'.repeat(LIMITS.initialVerdictChars + 1));
      } catch (error) {
        failures.push(error.code);
        assert.equal(error.limit, LIMITS.initialVerdictChars);
      }
      assert.equal(reveal('accepted after rejected attempts'), WORKER_REPORT);
      return 'final';
    },
  });

  assert.deepEqual(failures, ['EMPTY_INITIAL_VERDICT', 'INITIAL_VERDICT_TOO_LONG']);
  assert.equal(result.initialVerdict, 'accepted after rejected attempts');
});

test('empty or oversized final verdicts fail closed', async () => {
  const base = {
    task: TASK,
    runWorker: async () => WORKER_REPORT,
    getEvidence: async () => EVIDENCE,
  };

  await assert.rejects(
    runBoost({
      ...base,
      runReviewer: async (prompt, reveal) => {
        reveal('initial');
        return '   ';
      },
    }),
    (error) => error.code === 'EMPTY_FINAL_VERDICT',
  );

  await assert.rejects(
    runBoost({
      ...base,
      runReviewer: async (prompt, reveal) => {
        reveal('initial');
        return 'f'.repeat(LIMITS.finalVerdictChars + 1);
      },
    }),
    (error) => {
      assert.equal(error.code, 'FINAL_VERDICT_TOO_LONG');
      assert.equal(error.limit, LIMITS.finalVerdictChars);
      return true;
    },
  );
});

test('limits are exported as a frozen, usable table', () => {
  assert.ok(Object.isFrozen(LIMITS));
  for (const [name, value] of Object.entries(LIMITS)) {
    assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  }
});

test('reveal after the run has ended is rejected', async () => {
  let lateReveal;
  const result = await runBoost({
    task: TASK,
    runWorker: async () => WORKER_REPORT,
    getEvidence: async () => EVIDENCE,
    runReviewer: async (prompt, reveal) => {
      lateReveal = reveal;
      reveal('initial verdict');
      return 'final verdict';
    },
  });

  assert.equal(result.initialVerdict, 'initial verdict');
  assert.throws(
    () => lateReveal('late overwrite'),
    (error) => error.code === 'REVEAL_AFTER_END',
  );
  assert.equal(result.initialVerdict, 'initial verdict');
});

test('reveal after a failed run is rejected', async () => {
  let lateReveal;
  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => EVIDENCE,
      runReviewer: async (prompt, reveal) => {
        lateReveal = reveal;
        reveal('initial verdict');
        return '   ';
      },
    }),
    (error) => error.code === 'EMPTY_FINAL_VERDICT',
  );

  assert.throws(
    () => lateReveal('late overwrite'),
    (error) => error.code === 'REVEAL_AFTER_END',
  );
});

test('a reviewer rejection propagates and ends the reveal tool', async () => {
  const boom = new Error('reviewer crashed');
  let lateReveal;

  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => EVIDENCE,
      runReviewer: async (prompt, reveal) => {
        lateReveal = reveal;
        throw boom;
      },
    }),
    (error) => error === boom,
  );

  assert.throws(
    () => lateReveal('late overwrite'),
    (error) => error.code === 'REVEAL_AFTER_END',
  );
});

test('concurrent runs keep reveal locks and predecessor reports isolated', async () => {
  const gates = { a: deferred(), b: deferred() };
  const ready = { a: deferred(), b: deferred() };
  let revealA;
  let revealB;

  const runA = runBoost({
    task: 'Task A',
    runWorker: async () => 'REPORT-A',
    getEvidence: async () => 'EVIDENCE-A',
    runReviewer: async (prompt, reveal) => {
      revealA = reveal;
      ready.a.resolve();
      await gates.a.promise;
      return 'FINAL-A';
    },
  });

  const runB = runBoost({
    task: 'Task B',
    runWorker: async () => 'REPORT-B',
    getEvidence: async () => 'EVIDENCE-B',
    runReviewer: async (prompt, reveal) => {
      revealB = reveal;
      ready.b.resolve();
      await gates.b.promise;
      return 'FINAL-B';
    },
  });

  await Promise.all([ready.a.promise, ready.b.promise]);

  assert.equal(revealB('INITIAL-B'), 'REPORT-B');
  assert.equal(revealA('INITIAL-A'), 'REPORT-A');
  assert.throws(() => revealB('OVERWRITE-B'), (error) => error.code === 'INITIAL_VERDICT_ALREADY_REVEALED');

  gates.b.resolve();
  gates.a.resolve();

  const [resultA, resultB] = await Promise.all([runA, runB]);
  assert.deepEqual(resultA, {
    workerReport: 'REPORT-A',
    initialVerdict: 'INITIAL-A',
    finalVerdict: 'FINAL-A',
  });
  assert.deepEqual(resultB, {
    workerReport: 'REPORT-B',
    initialVerdict: 'INITIAL-B',
    finalVerdict: 'FINAL-B',
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('an already-aborted signal stops the run before any callback', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  await assert.rejects(
    runBoost({
      task: TASK,
      signal: controller.signal,
      runWorker: async () => { calls += 1; return WORKER_REPORT; },
      getEvidence: async () => { calls += 1; return EVIDENCE; },
      runReviewer: async () => { calls += 1; return 'final'; },
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(calls, 0);
});

test('aborting during the worker rejects promptly and skips evidence and review', async () => {
  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  let evidenceCalls = 0;
  let reviewerCalls = 0;

  const run = runBoost({
    task: TASK,
    signal: controller.signal,
    runWorker: async () => {
      started.resolve();
      await release.promise;
      return WORKER_REPORT;
    },
    getEvidence: async () => { evidenceCalls += 1; return EVIDENCE; },
    runReviewer: async () => { reviewerCalls += 1; return 'final'; },
  });

  await started.promise;
  controller.abort();
  await assert.rejects(run, (error) => error.name === 'AbortError');
  release.resolve();

  assert.equal(evidenceCalls, 0);
  assert.equal(reviewerCalls, 0);
});

test('an abort raised inside the worker stops the run at the evidence boundary', async () => {
  const controller = new AbortController();
  let evidenceCalls = 0;

  await assert.rejects(
    runBoost({
      task: TASK,
      signal: controller.signal,
      runWorker: async () => {
        controller.abort();
        return WORKER_REPORT;
      },
      getEvidence: async () => { evidenceCalls += 1; return EVIDENCE; },
      runReviewer: async () => 'final',
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(evidenceCalls, 0);
});

test('aborting during the reviewer disables reveal and rejects the run', async () => {
  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  let capturedReveal;

  const run = runBoost({
    task: TASK,
    signal: controller.signal,
    runWorker: async () => WORKER_REPORT,
    getEvidence: async () => EVIDENCE,
    runReviewer: async (prompt, reveal) => {
      capturedReveal = reveal;
      started.resolve();
      await release.promise;
      return FINAL_VERDICT;
    },
  });

  await started.promise;
  controller.abort();
  await assert.rejects(run, (error) => error.name === 'AbortError');
  release.resolve();

  assert.throws(
    () => capturedReveal('late initial verdict'),
    (error) => error.code === 'REVEAL_AFTER_END',
  );
});

test('an abort after reveal still rejects instead of returning the final verdict', async () => {
  const controller = new AbortController();

  await assert.rejects(
    runBoost({
      task: TASK,
      signal: controller.signal,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => EVIDENCE,
      runReviewer: async (prompt, reveal) => {
        reveal('initial verdict');
        controller.abort();
        return FINAL_VERDICT;
      },
    }),
    (error) => error.name === 'AbortError',
  );
});

test('a non-AbortSignal signal argument is rejected', async () => {
  await assert.rejects(
    runBoost({
      task: TASK,
      signal: {},
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => EVIDENCE,
      runReviewer: async () => 'final',
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('aborting during evidence collection skips the reviewer', async () => {
  const controller = new AbortController();
  let reviewerCalls = 0;

  await assert.rejects(
    runBoost({
      task: TASK,
      signal: controller.signal,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => {
        controller.abort();
        return EVIDENCE;
      },
      runReviewer: async () => { reviewerCalls += 1; return 'final'; },
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(reviewerCalls, 0);
});

test('a worker failure propagates before evidence collection', async () => {
  const boom = new Error('worker failed');
  let evidenceCalls = 0;

  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => { throw boom; },
      getEvidence: async () => { evidenceCalls += 1; return EVIDENCE; },
      runReviewer: async () => 'final',
    }),
    (error) => error === boom,
  );
  assert.equal(evidenceCalls, 0);
});

test('an evidence failure propagates before review', async () => {
  const boom = new Error('evidence failed');
  let reviewerCalls = 0;

  await assert.rejects(
    runBoost({
      task: TASK,
      runWorker: async () => WORKER_REPORT,
      getEvidence: async () => { throw boom; },
      runReviewer: async () => { reviewerCalls += 1; return 'final'; },
    }),
    (error) => error === boom,
  );
  assert.equal(reviewerCalls, 0);
});
