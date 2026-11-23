import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDossier} from '../src/dossier.js';
const state=()=>({runId:'tw-r',status:'paused',rounds:{current:2},originalRequest:'Correct boundary values',interview:{confirmation:{source:'manual-chat'}},spec:{version:3,text:'Frozen baseline',confirmedCommand:'node acceptance.mjs'},plan:{tasks:[{id:'impl-r2',role:'implementer',status:'pending'}]},ledger:{open:[{id:'I1',summary:'Negative inputs are accepted',severity:'high',evidence:'f(-1) returned -1'}],closed:[]},gate:{decision:'retry'},audit:{status:'idle'},trace:[{type:'paused',summary:'Manual pause'}],lock:{token:'private-token'},evidence:{latest:{check:{command:'node acceptance.mjs',exitCode:1,stderr:'Assertion failed'}}}});
test('dossier preserves source, plan, issue evidence, check and next handoff without leaking internal locks',()=>{
 const s=state(),md=renderDossier(s);for(const v of ['ORIGINAL_REQUEST','Frozen baseline','PROJECT','impl-r2','GATE_STATUS','I1','f(-1)','exit 1','Assertion failed','HANDOFF','paused'])assert.ok(md.includes(v),v);assert.doesNotMatch(md,/private-token/);
});
test('report the newest auditor recheck over the earlier reviewer receipt',()=>{
 const s=state();s.evidence.latest={command:'node acceptance.mjs',exitCode:0,stdout:'initial pass'};assert.match(renderDossier(s),/exit 0/);
 s.audit.evidence={command:'node acceptance.mjs',exitCode:2,stderr:'audit rerun failed'};assert.match(renderDossier(s),/exit 2[\s\S]*audit rerun failed/);
});
test('preview is bounded, does not freeze a draft or invent success when no check exists',()=>{
 const s=state();s.status='draft';s.interview.confirmation=null;s.spec.text='X'.repeat(100000);s.evidence.latest=null;const out=renderDossier(s);assert.ok(out.length<20000);assert.match(out,/UNCONFIRMED/i);assert.match(out,/not recorded/i);assert.equal(s.spec.text.length,100000);
});
