// Optional installed-runtime check. No profile, browser, credentials or remote model.
// Load the shipped Cordis services, register the actual command/roles, drive two
// scripted activations and dispatch their tool calls through the native executor.
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
  const events = []; let mode = 'negative';
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
      assert.equal(res.value, marker, JSON.stringify(res));
      assert.equal((await invoke(agent,'boost_reveal',{initialVerdict:'overwrite'})).isError, true);
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
    for(const [role,key] of Object.entries(roles)) {
      const s=createScope(ctx,key);scopes.push(s);fibers.push(s.ctx.plugin(policy,{role}));
    }
    fibers.push(ctx.plugin(plugin)); await tick();
    assert.deepEqual(ctx.tools.schemas(roles.reviewer).map(x=>x.name),['boost_reveal']);
    const help = await ctx.commands.execute(parent,'/boost help',[],signal);
    assert.equal(help.result.kind,'success'); assert.match(help.result.text,/Example:/); logs.length=0;
    const line=`/boost Fix clamp\n@file fixtures/boundary.mjs\n@check ${command}`;
    async function run() { const {result}=await ctx.commands.execute(parent,line,[],signal);return result; }
    const result=await run();assert.deepEqual(events,['worker','check','reviewer'],result.text);
    assert.equal(result.kind,'error',result.text); assert.match(result.text,/exit 1/);assert.match(result.text,/Boundary fails at -1/);
    assert.match(result.text,/clamp\(-1, 9\) must be zero/);assert.match(result.text,/Disagree/);
    assert.match(result.text,/impl-report:/);
    mode='no-reveal';assert.match((await run()).text,/before a successful boost_reveal/);
    assert.deepEqual(logs.map(x=>x[0]), ['command/run','command/done','command/run','command/done']);
  } finally {
    for(const f of fibers.reverse()) await f.dispose();
    for(const s of scopes) await s.dispose();
  }
});
