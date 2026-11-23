// Optional installed-runtime check. No profile, browser, credentials or remote model.
// Load the shipped Cordis services, register the actual command/roles, drive
// scripted activations and dispatch their tool calls through the native executor.
// Regression coverage: a post-execute policy that blocks or replaces boost_reveal's
// final content must fail the run, preserve the locked verdict, and never print
// "Final comparison", while the no-policy run keeps working unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugin from '../index.js';
import * as policy from '../src/policy.js';

const runtime = process.env.BOOST_TEST_RUNTIME;
const repo = fileURLToPath(new URL('../', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('installed DSH runtime: command → worker → failing boundary check → blind verdict → comparison', { skip: !runtime && 'Set BOOST_TEST_RUNTIME to the DSH package resolver manifest' }, async () => {
  const require = createRequire(runtime);
  const { Context } = require('@deepseek-ai/cordis');
  const { createScope, bindScopeParent } = require('@deepseek-ai/dsh-scope');
  const ctx = new Context();
  function provide(key, value) { ctx.provide(key); ctx.set(key, value); }
  provide('systemPrompt', { tools() {}, section() {} });
  const logs = [], parent = {id:'root',session:{append(...args){logs.push(args);}}};
  const roles = {worker:{},reviewer:{}};
  const marker = 'impl-report: all boundary cases covered';
  const events = []; let mode = 'negative'; let postExecute = 'pass'; let reviewerFailure = false;
  const signal = new AbortController().signal;
  function invoke(agent, name, args) {
    return ctx.tools.execute({agent, signal, calls:[{type:'tool-call',id:'test',name,arguments:JSON.stringify(args)}]})
      .then(batch => batch.results[0].result);
  }
  const command = 'node fixtures/check-boundary.mjs';
  provide('subagents', {rootOf: a => a, resolveMaxDepth: () => 1, async startActivation(spec) {
    const role = spec.agentPreset.slice('dk-boost-'.length);
    assert.equal(spec.parent, parent); assert.equal(spec.provider, 'spawn'); assert.equal(spec.delivery, 'caller');
    const agent = {id:spec.childId}; bindScopeParent(agent, roles[role]);
    const task = async () => {
      events.push(role);
      if (role === 'worker') return marker;
      const packet = spec.prompt[0].text;
      assert.doesNotMatch(packet, /impl-report:/); assert.match(packet, /clamp\(-1, 9\) must be zero/);
      assert.match(packet, /n < 0 \? n/);
      assert.equal((await invoke(agent,'read',{})).isError, true, 'no reviewer fs access');
      if (mode === 'no-reveal') return 'unsupported final answer';
      const res = await invoke(agent,'boost_reveal',{initialVerdict:'Boundary fails at -1.'});
      if (postExecute === 'block') {
        assert.equal(res.isError, true, JSON.stringify(res));
        assert.match(res.content[0].text, /blocked by post-execute policy/);
        if (reviewerFailure) throw new Error('reviewer stopped after the blocked reveal');
        return 'The report was blocked; I cannot compare.';
      }
      if (postExecute === 'replace') {
        assert.equal(res.isError, false, JSON.stringify(res));
        assert.equal(res.value, marker, 'canonical value survives content replacement');
        assert.equal(res.content[0].text, 'policy summary instead of the worker report');
        return 'The report was replaced; I cannot compare.';
      }
      assert.equal(res.value, marker, JSON.stringify(res));
      assert.equal((await invoke(agent,'boost_reveal',{initialVerdict:'overwrite'})).isError, true);
      if (reviewerFailure) throw new Error('reviewer stopped after reading the report');
      return 'Disagree: the real negative boundary test failed.';
    };
    return { childId:spec.childId, dispose:async()=>{}, result:task().then(text=>({stopReason:'completed',output:[{type:'text',text}]})) };
  } });
  provide('workingDirectory',{ensure: async () => repo});
  provide('fs', { resolve: async (file,{cwd=repo}={}) => ({targetKey: await realpath(path.resolve(cwd,file))}), processPath:t=>t.targetKey,
    contains: (a,b)=>!path.relative(a.targetKey,b.targetKey).startsWith('..') });
  const fibers = [ctx.plugin(require('@deepseek-ai/dsh-commands').CommandRuntime),ctx.plugin(require('@deepseek-ai/dsh-tools').default)];
  const scopes = [];
  try {
    await tick(); fibers.push(ctx.plugin(require('@deepseek-ai/dsh-tool-executor-native'))); await tick();
    function addTool(name, outputSchema, run) {
      ctx.tools.register({name, description:`Test ${name}`,parameters:{type:'object',additionalProperties:true},
        output:{schema:outputSchema,render:(_args,v)=>[{type:'text',text:typeof v==='string'? v : JSON.stringify(v)}]},execute:run});
    }
    // Fixture adapters only accept known inputs. Never execute model-supplied shell in tests.
    addTool('bash',{type:'object',additionalProperties:true},async args=>{
      assert.equal(args.command, command); events.push('check');
      const proc=spawnSync(process.execPath,['fixtures/check-boundary.mjs'],{cwd:repo,encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
      assert.equal(proc.status,1,proc.stderr); assert.match(proc.stderr,/AssertionError/);
      return {kind:'foreground',exitCode:proc.status,stdout:{text:proc.stdout},stderr:{text:proc.stderr}};
    });
    addTool('read',{type:'string'},async args=>{
      assert.equal(args.file_path,path.resolve(repo,'fixtures/boundary.mjs'));return readFile(args.file_path,'utf8');
    });
    const scopeByRole = {};
    for(const [role,key] of Object.entries(roles)) {
      const s=createScope(ctx,key);scopes.push(s);scopeByRole[role]=s;fibers.push(s.ctx.plugin(policy,{role}));
    }
    scopeByRole.reviewer.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name !== 'boost_reveal' || postExecute === 'pass') return next();
      if (postExecute === 'block') return {kind:'block',feedback:[{type:'text',text:'blocked by post-execute policy'}]};
      if (postExecute === 'replace') return {kind:'accept',content:[{type:'text',text:'policy summary instead of the worker report'}]};
      return next();
    });
    fibers.push(ctx.plugin(plugin)); await tick();
    assert.deepEqual(ctx.tools.schemas(roles.reviewer).map(x=>x.name),['boost_reveal']);
    const help = await ctx.commands.execute(parent,'/boost help',[],signal);
    assert.equal(help.result.kind,'success'); assert.match(help.result.text,/Example:/); logs.length=0;
    const line=`/boost Fix clamp\n@file fixtures/boundary.mjs\n@check ${command}`;
    async function run() { const {result}=await ctx.commands.execute(parent,line,[],signal);return result; }
    const result=await run();assert.deepEqual(events,['worker','check','reviewer'],result.text);
    assert.equal(result.kind,'error',result.text); assert.match(result.text,/exit 1/);assert.match(result.text,/Boundary fails at -1/);
    assert.match(result.text,/clamp\(-1, 9\) must be zero/);assert.match(result.text,/Disagree/);
    assert.match(result.text,/impl-report:/);assert.match(result.text,/Final comparison/);
    events.length=0;
    mode='no-reveal';assert.match((await run()).text,/before a successful boost_reveal/);
    mode='negative';

    const incomplete = (outcome, deliveryFailure) => {
      assert.equal(outcome.kind,'error',outcome.text);
      assert.match(outcome.text, /worker report was not delivered/);
      assert.match(outcome.text, deliveryFailure);
      assert.match(outcome.text, /Initial verdict \(locked; delivery of the worker report was not confirmed\)/);
      assert.match(outcome.text, /Boundary fails at -1/);
      assert.match(outcome.text, /comparison is incomplete/i);
      assert.doesNotMatch(outcome.text, /Final comparison/);
      assert.doesNotMatch(outcome.text, /impl-report:/);
    };

    events.length=0; postExecute='block';
    incomplete(await run(), /\(delivery: error-result\)/);
    assert.deepEqual(events,['worker','check','reviewer']);

    events.length=0; postExecute='replace';
    incomplete(await run(), /\(delivery: content-mismatch\)/);
    assert.deepEqual(events,['worker','check','reviewer']);

    // A blocked reveal followed by a reviewer failure must still surface the
    // locked verdict instead of losing it to the thrown error.
    events.length=0; postExecute='block'; reviewerFailure=true;
    const crashed=await run();
    assert.equal(crashed.kind,'error',crashed.text);
    assert.match(crashed.text,/reviewer stopped after the blocked reveal/);
    assert.match(crashed.text,/Initial verdict \(locked; delivery of the worker report was not confirmed\)/);
    assert.match(crashed.text,/Boundary fails at -1/);
    assert.match(crashed.text,/comparison is incomplete/i);
    assert.doesNotMatch(crashed.text,/Final comparison/);
    assert.doesNotMatch(crashed.text,/impl-report:/);
    assert.deepEqual(events,['worker','check','reviewer']);
    reviewerFailure=false;

    // A reviewer failure after a confirmed delivery still surfaces the locked
    // verdict, but does not pretend delivery failed.
    events.length=0; postExecute='pass'; reviewerFailure=true;
    const deliveredCrash=await run();
    assert.equal(deliveredCrash.kind,'error',deliveredCrash.text);
    assert.match(deliveredCrash.text,/reviewer stopped after reading the report/);
    assert.match(deliveredCrash.text,/Initial verdict \(locked; the run failed before producing a final comparison\)/);
    assert.match(deliveredCrash.text,/Boundary fails at -1/);
    assert.match(deliveredCrash.text,/comparison is incomplete/i);
    assert.doesNotMatch(deliveredCrash.text,/Final comparison/);
    assert.doesNotMatch(deliveredCrash.text,/impl-report:/);
    assert.deepEqual(events,['worker','check','reviewer']);
    reviewerFailure=false;

    assert.deepEqual(logs.map(x=>x[0]), ['command/run','command/done','command/run','command/done','command/run','command/done','command/run','command/done','command/run','command/done','command/run','command/done']);
  } finally {
    for(const f of fibers.reverse()) await f.dispose();
    for(const s of scopes) await s.dispose();
  }
});
