# dk-dsh-helm

Boost、Swarm 和 Teamwork 共用[仓库版本号](VERSION)，统一发版，可按需单独安装。三个插件均面向 DSH `0.2.2-rc.5`。

| 插件 | 适用场景 |
| --- | --- |
| [Boost](packages/boost/README.md) | 一个执行者完成任务，一个独立复核者先做盲审，再对照执行报告。 |
| [Swarm](packages/swarm/README.md) | 同一子代理树通过持久黑板、频道和定向唤醒协作。 |
| [Teamwork](packages/teamwork/README.md) | 先人工确认规格，再按工程路线派工、运行验收并独立审计。 |

在 DSH 的测试 profile 中选择相应的插件子目录安装，也可在该子目录运行 `npm pack` 生成单独的安装包。安装前请阅读各插件说明中的权限、工作区和验证边界。
