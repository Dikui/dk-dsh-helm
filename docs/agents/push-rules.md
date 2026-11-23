# 推送规则

初次导入三个独立版本的 DSH 插件；没有单独的总包版本。目标为 `Dikui/dk-dsh-helm` 的 `main`。

以下是人工复核过的误报：非凭据的规格摘要和运行锁引用、测试输入和预期输出，以及两份依赖锁文件的文件名。每条规则只匹配指定路径及完整文本；修改后重新审查。

```safe-push-allow
packages/teamwork/src/campaign.js ^    token[:] hashToken\('plan', \{ route, version, tasks[:] limited\.map\(t [=]> t\.id\) \}\),$
packages/teamwork/src/campaign.js ^    token[:] draft\.token,$
packages/teamwork/src/campaign.js ^    token[:] makeLeaseToken\(ownerId, at\),$
packages/teamwork/src/campaign.js ^  return \{ state[:] serializeSafe\(next\), result[:] ok\(\{ token[:] next\.lock\.token \}\) \};$
packages/teamwork/src/campaign.js ^  plan\.token [=] hashToken\('plan', plan\.tasks\.map\(t [=]> \[t\.id, t\.role, t\.preset, t\.deps, t\.status\]\)\);$
packages/teamwork/src/host-command.js ^        leaseToken[:] acquired\?\.state\?\.lock\?\.token \?\? leaseToken,$
packages/teamwork/src/host-command.js ^            token[:] state\.interview\.draft\.token,$
packages/teamwork/src/host-runner.js ^      if \(leaseToken ![=][=] undefined && payload\.leaseToken [=][=][=] undefined\) payload\.leaseToken [=] leaseToken$
packages/teamwork/src/interview.js ^  const token [=] draftToken\(\{$
packages/teamwork/test/campaign.test.js ^    token[:] draft\.token,$
packages/teamwork/test/campaign.test.js ^    type[:] 'confirm', text[:] draft\.confirmLine, token[:] draft\.token,$
packages/teamwork/test/campaign.test.js ^    type[:] 'confirm', text[:] `\$\{draft\.confirmLine\} `, token[:] draft\.token,$
packages/teamwork/test/campaign.test.js ^  assert\.equal\(step\(state,\{type[:]'confirm',text[:]old\.confirmLine,token[:]fresh\.token,version[:]fresh\.version,source[:]'manual-chat'\}\)\.result\.code, 'TEXT_MISMATCH'\);$
packages/teamwork/test/campaign.test.js ^    type[:] 'confirm', text[:] fresh\.confirmLine, token[:] fresh\.token,$
packages/teamwork/test/campaign.test.js ^    type[:] 'confirm', text[:] fresh\.confirmLine, token[:] old\.token,$
packages/teamwork/test/campaign.test.js ^    type[:] 'confirm', text[:] 'yes', token[:] fresh\.token,$
packages/teamwork/test/campaign.test.js ^    token[:] state\.spec\.token, version[:] state\.spec\.version, source[:] 'manual-chat',$
packages/teamwork/test/campaign.test.js ^    text[:] state\.interview\.draft\.confirmLine, token[:] state\.spec\.token,$
packages/teamwork/test/campaign.test.js ^    childSessionId[:] 'impl-1', leaseToken[:] state\.lock\.token,$
packages/teamwork/test/campaign.test.js ^  assert\.equal\(canStart\(leased, \{ cwd[:] '/tmp/demo', now[:] NOW, leaseToken[:] leased\.lock\.token \}\)\.code, 'REENTRANT'\);$
packages/teamwork/test/dossier.test.js ^const state[=]\(\)[=]>\(\{runId[:]'tw-r',status[:]'paused',rounds[:]\{current[:]2\},originalRequest[:]'Correct boundary values',interview[:]\{confirmation[:]\{source[:]'manual-chat'\}\},spec[:]\{version[:]3,text[:]'Frozen baseline',confirmedCommand[:]'node acceptance\.mjs'\},plan[:]\{tasks[:]\[\{id[:]'impl-r2',role[:]'implementer',status[:]'pending'\}\]\},ledger[:]\{open[:]\[\{id[:]'I1',summary[:]'Negative inputs are accepted',severity[:]'high',evidence[:]'f\(-1\) returned -1'\}\],closed[:]\[\]\},gate[:]\{decision[:]'retry'\},audit[:]\{status[:]'idle'\},trace[:]\[\{type[:]'paused',summary[:]'Manual pause'\}\],lock[:]\{token[:]'private-token'\},evidence[:]\{latest[:]\{check[:]\{command[:]'node acceptance\.mjs',exitCode[:]1,stderr[:]'Assertion failed'\}\}\}\}\);$
packages/teamwork/test/host.test.js ^    token[:] draft\.token,$
packages/swarm/test/board.test.js ^  const parsed [=] parseMentions\('hi [@]worker-1, mail a[@]b\.com and [@]all [@]#ops; x[@]#no'\);$
packages/teamwork/test/host-runtime.test.js ^    await writeFile\(path\.join\(workspace, 'accept-pass\.mjs'\), "console\.log\('acceptance ok'\)\\n"\);$
packages/teamwork/test/host-runtime.test.js ^    await writeFile\(path\.join\(workspace, 'general-pass\.mjs'\), "console\.log\('general acceptance ok'\)\\n"\);$
packages/teamwork/src/host-command.js ^            token[:] draft\.token,$
packages/boost/src/reveal.js ^  const token [=] execution ![=][=] null && typeof execution [=][=][=] 'object' \? execution\.token [:] undefined$
packages/boost/src/reveal.js ^  const token [=] exec ![=][=] null && typeof exec [=][=][=] 'object' \? exec\.token [:] undefined$
packages/boost/src/reveal.js ^  const token [=] execution\.token$
packages/boost/test/roles.test.js ^    \['string token', \{ \.\.\.base, token[:] 'not-a-symbol' \}\],$
packages/swarm/src/host-tools.js ^              token[:] exec\.token,$
packages/swarm/package-lock.json ^packages/swarm/package-lock\.json$
packages/teamwork/package-lock.json ^packages/teamwork/package-lock\.json$
```
