// Render a read-only handoff from one stored revision. Do not expose lock
// credentials, full file snapshots, model prompts or implementation session IDs.
const clip = (value, limit) => {
  const s = typeof value === 'string' ? value : '';
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
};
export function renderDossier(s) {
  const receipt=s.audit?.evidence ?? s.evidence?.latest;
  const check=receipt?.check ?? receipt, issues=s.ledger?.open??[], tasks=s.plan?.tasks??[], trace=s.trace??[];
  const lines=[`# Teamwork ${s.runId} — ${s.status}`,`Revision ${s.revision??0}; round ${s.rounds?.current??0}/${s.rounds?.max??'?'}`,
    '', '## ORIGINAL_REQUEST',clip(s.originalRequest,1800), '',`## SPEC · ${s.interview?.confirmation?'confirmed':'UNCONFIRMED'} (v${s.spec?.version??0})`,
    clip(s.spec?.text,3200)||'No specification yet.', '', '## PROJECT',
    ...tasks.slice(0,16).map(t=>`- ${clip(t.id,70)} · ${clip(t.role,40)}: ${clip(t.status,40)}`),
    '', '## GATE_STATUS',`Decision: ${s.gate?.decision??'pending'}; independent audit: ${s.audit?.status??'pending'}.`,
    `Confirmed check: ${clip(s.spec?.confirmedCommand,600)||'not recorded'}`,
    check && Number.isInteger(check.exitCode)?`Last receipt: exit ${check.exitCode}.\n${clip(check.stderr || check.stdout,900)}`:'Last receipt: not recorded.',
    '', `## ISSUES (${issues.length} open, ${s.ledger?.closed?.length??0} closed)`,
    ...issues.slice(0,12).map(i=>`- ${clip(i.id,70)} [${clip(i.severity,40)}] ${clip(i.summary,145)} · ${clip(i.evidence,145)}`),
    '', '## TRACE',...trace.slice(-8).map(e=>`- ${clip(e.type,50)}: ${clip(e.summary,130)}`),
    '', '## HANDOFF',s.status==='done'?'Completed; consult the independent audit and check receipt.':s.status==='paused'?'Paused: review the open issues and latest receipt before an explicit resume.':'Not accepted as complete. Consult the current gate and pending tasks before proceeding.'
  ];
  return lines.join('\n');
}
