import test from 'node:test';
import assert from 'node:assert/strict';
import {createCampaign} from '../src/campaign.js';
import {buildRetryBrief,executeCampaign} from '../src/host-runner.js';
test('fresh writer gets bounded issue evidence and the previous rejection on retry',()=>{
 const brief=buildRetryBrief({ledger:{open:[{id:'ISS-1',summary:'negative escaped',evidence:'src/check.js:3'},{id:'ISS-2',summary:'x'.repeat(5000)}]},rounds:{history:[{failed:[{id:'review-r1',reason:'bad boundary'}]}]},audit:{reason:'prior audit failed'}});
 assert.match(brief,/ISS-1.*negative escaped.*src\/check.js:3/u);assert.match(brief,/review-r1: bad boundary/u);assert.match(brief,/prior audit failed/u);assert.ok(brief.length<=4200);assert.equal(buildRetryBrief({}), '');
});
import {createMemoryStore} from './support/memory-store.js';
async function exercise(codes) {
 const handle=await createCampaign({}, {runId:'tw-receipt',rootSessionId:'root',cwd:'/tmp/fixture',mode:'swe-light',skipInterview:true,originalRequest:'Fix boundary',confirmedCommand:'test-boundary'},{store:createMemoryStore()});
 const d=handle.state.interview.draft;assert.ok((await handle.reduce({type:'confirm',text:d.confirmLine,token:d.token,version:d.version,source:'manual-chat'})).result.ok);
 const used=[], ctx={fs:{resolve:async p=>p},tools:{executable:()=>true,async execute({calls:[call]}){assert.equal(call.name,'bash');const exitCode=codes.shift();assert.ok(Number.isInteger(exitCode),'unexpected extra check');return {results:[{callId:call.id,result:{value:{kind:'foreground',exitCode,stdout:{text:''},stderr:{text:exitCode?'clamp(-1) returned -1':''}}}}]};}},subagents:{rootOf:a=>a,resolveMaxDepth:()=>1,async startActivation(spec){used.push(spec.agentPreset);return {result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:spec.agentPreset.endsWith('auditor')?'VERDICT|pass|ok\nPHASE A|pass\nPHASE B|pass\nPHASE C|pass':'VERDICT|pass|ok'}]}),dispose:()=>{}};}}};
 const result=await executeCampaign({ctx,handle,agent:{id:'root'},cwd:handle.state.cwd,signal:new AbortController().signal,runId:handle.state.runId});
 return {result, state:handle.state,used, async resume(){assert.ok((await handle.reduce({type:'resume',source:'manual-chat'})).result.ok);await executeCampaign({ctx,handle,agent:{id:'root'},cwd:handle.state.cwd,signal:new AbortController().signal,runId:handle.state.runId});return handle.state;}};
}
test('post-write failure cannot pass a round even if the reviewer falsely reports pass',async()=>{
 const {state,used}=await exercise([1,0]);assert.ok(!used.includes('dk-teamwork-auditor'),'failure must stop before victory audit');assert.equal(state.status,'paused');assert.equal(state.evidence.latest.exitCode,1);
});
test('fresh audit failure cannot be replaced by earlier evidence or an auditor self-report',async()=>{
 const {state,result,resume}=await exercise([0,2,0]);assert.equal(state.status,'paused');const last=state.audit?.evidence??state.evidence?.latest;assert.equal(last.exitCode,2);assert.doesNotMatch(result.summary,/Victory audit: passed/);assert.equal((await resume()).status,'done','resuming an interrupted audit must rerun the frozen command and auditor');
});
