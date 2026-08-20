<p align="center">
</p>

<p align="center">
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml"><img src="https://github.com/ecoma-io/reeve/actions/workflows/analysis.yml/badge.svg" alt="Analysis" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/ecoma-io/reeve/releases/latest"><img src="https://img.shields.io/github/v/release/ecoma-io/reeve?sort=semver&color=brightgreen" alt="Latest release" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-7C3AED.svg" alt="Pull requests welcome" /></a>
</p>

<!-- reeve:ignore-start -->
<p align="center">
  <sub><a href="README.md">English</a> · <a href="README.vi.md">Tiếng Việt</a> · <strong>中文</strong></sub>
</p>
<!-- reeve:ignore-end -->

<p align="center">
  <img src=".github/assets/banner.png" alt="Reeve — 以每位贡献者的语言维护仓库" width="100%" />
</p>

<h1 align="center">Reeve</h1>

<p align="center">
  <strong>你收到过的最有用的错误报告，是用你读不懂的语言写的。</strong><br />
  Reeve 让仓库的常规工作持续推进——分类、匹配、回复、审查、维护依赖——<br />
  <em>无论它以何种语言到来，都在你写下且它无法逾越的授权范围之内。</em>
</p>

## 为什么选择 Reeve

你的贡献者们并非都使用同一种语言，而这个领域里几乎每一个正经的工具都表现得
好像他们是。这一点在最不显眼的地方体现出来：不是翻译，而是**决策**。分类
问题更严重。重复检测干脆失效——同一个崩溃的两份报告，一份用越南语，一份用
英语，永远不会相遇。这个月你收到的最有价值的报告的作者，得到的回复反而比一
个用英语含糊描述问题的人更慢、更差。

Reeve 把语言当作核心机制所理解、且每个 duty 都会使用的东西。它的运作方式也
正如其名所示：一位 "reeve" 是代表庄园主管理庄园的官员——日常工作，无需每次
都被吩咐，在庄园主授予且随时可以收回的权限范围内完成。庄园主始终是庄园主。
它不是聊天机器人，不是托管服务，也不是工作流引擎——九个 duty，一份 warrant
文件,属于你的仓库。
[北极星](docs/doctrine/north-star.md) 就是全部论点所在。

## 各项 duty

每个 duty 都是独立的 action。运行多少，完全取决于你写下了多少，一次只走
[阶梯](docs/concepts/authority-model.md)上的一级。

| Duty          | 它做什么                                                                                                                    | 参考文档                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `triage`      | 按你写下的分类体系对 backlog 进行分类——或者在最低权限层级下，按你仓库已有的 label 分类。                                    | [参考](docs/reference/duties/triage.md)      |
| `translate`   | 把每个 issue 和 pull request 翻译成你的项目所支持的每一种语言——直接写在该 thread 自己的正文里，并标注为唯一算数的版本。     | [参考](docs/reference/duties/translate.md)   |
| `duplicate`   | 找出已经报告过同一问题的 thread——跨越报告所用的语言。默认关闭，绝不会意外开启。                                             | [参考](docs/reference/duties/duplicate.md)   |
| `respond`     | 用陌生人写给你的那种语言，给出第一条有用的回复，依据是项目已知的信息。在 warrant 明确授权之前不会被赋予任何权限。           | [参考](docs/reference/duties/respond.md)     |
| `review`      | 审查一个 pull request——先进行确定性的预检查，再由按风险分级的多轮模型审查综合成一条它自己拥有的评论，追踪发现而非重复发布。 | [参考](docs/reference/duties/review.md)      |
| `remediation` | 把一次 review 中仍然有效的发现，转化为确定性的修复建议——记录在 job summary 中，绝不写入仓库。                               | [参考](docs/reference/duties/remediation.md) |
| `lifecycle`   | 执行你自己的过期（staleness）策略——提醒、取消过期标记、最终以 not planned 关闭——仅依据时间戳和 label。从不调用模型。        | [参考](docs/reference/duties/lifecycle.md)   |
| `harmonise`   | 在源文档变化时，让你的多语言文档保持同步。在 warrant 授予更多权限之前，仅进行报告。                                         | [参考](docs/reference/duties/harmonise.md)   |
| `dependa`     | 维护你的依赖——发现更新、评估风险、开出可供审查的 PR。在 warrant 授予更多权限之前，仅进行报告。                              | [参考](docs/reference/duties/dependa.md)     |

这九项之后还会增加什么，由一条严格的标准决定——反复出现、代价均匀高昂、已经被
维护者放弃过、并且在多语言项目上更加棘手。
[Doctrine D10](docs/doctrine/north-star.md#d10--a-duty-must-earn-its-place)
有意拒绝了绝大多数功能请求。

## 快速开始

五分钟，两个 duty，在你明确同意之前不会写入任何内容：

> [!IMPORTANT]
> 运行此 workflow 将在你的模型提供商账户上产生费用。
> `dry-run: true` 会运行整个流程但不写入任何内容——请先使用它。

1. **保存一个模型密钥**，作为名为 `OPENAI_API_KEY` 的仓库 secret——或者将
   `base-url` 指向任意兼容 OpenAI 的端点，包括无需密钥的免费端点：
   [Providers and the runtime](docs/guides/providers.md)。
2. **添加一个 workflow：**

```yaml
name: Reeve

on:
  issues:
    types: [opened, reopened, edited]

permissions:
  contents: read
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/triage@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          dry-run: true # safe first run — remove when you trust it

  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ecoma-io/reeve/translate@v0.6
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          models: gpt-5-mini
          dry-run: true # safe first run — remove when you trust it
```

> [!NOTE]
> `actions/checkout` 是必需的：Reeve 从本地 checkout 中读取你的 warrant
> 文件（`.github/reeve.yml`），而不是通过 GitHub API。

完整指南——触发条件、权限、版本锁定：
[Installation](docs/getting-started/installation.md) 和
[你的第一个 workflow](docs/getting-started/first-workflow.md)。在信任一份
warrant 之前，先问问 Reeve 它会做什么：
[the doctor](docs/guides/doctor.md) 会读取你的配置，并报告每个 duty 将被
授予什么权限,不写入任何内容。

## 一份你自己写下的授权

只有一份文件——`.github/reeve.yml`——是全部的授权。什么都不写，每个 duty
就都在其最窄的内置默认值下运行。写下一个 `duties:` 块，枚举就变成了完整的：
该块未提及的 duty 完全得不到任何授权。workflow 文件决定的是_何时_运行；它
无法授予任何 capability,模型的任何话也做不到这一点。
每一次权限扩大，都是对同一份文件的一次 diff，像其他任何变更一样接受审查。

[The authority model](docs/concepts/authority-model.md) ·
[The warrant guide](docs/guides/warrant.md) ·
[Every grant, enumerated](docs/reference/warrant-format.md#the-capabilities-table)

## 它拒绝做的事

这个页面上最重要的表格，每一行都在代码中强制执行：

|                           |                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **超出 warrant 范围行动** | 你的分类体系未命名的 label 永远不会被应用；你未授予的 capability 永远不会被使用。检查依据是解析后的文件——绝不依据模型自己关于它被允许做什么的说法。 |
| **改写他人写下的内容**    | 标题和正文属于写下它们的人。机器输出与人类文本并列展示,并加以标注,绝不会取而代之。                                                                  |
| **凌驾于维护者之上**      | 它绝不会移除他人应用的 label,绝不会重新分配,绝不会重新打开。它只提出建议;由你决定。                                                                 |
| **关闭、锁定或删除**      | 默认关闭,并将一直保持关闭。任何超出成本最低、可撤销操作之外的行为,都是逐一显式授权的。                                                              |
| **在无法读取时臆测**      | 无法解析的模型输出会产生**零**结果和一次醒目的红色失败——而不是对看起来还行的部分进行尽力而为的读取。                                                |
| **假装已经完成**          | 无法完成任务的运行会以红色失败告终。它绝不会以绿色状态报告一个空结果。                                                                              |
| **保留你的数据**          | 没有账户,没有仪表盘,没有托管状态。Reeve 所知道的一切,都是你仓库中的普通文件——在 pull request 中被审查,用 `rm` 删除。                                |

每条边界背后的推理都在
[the threat model](docs/security/threat-model.md) 中。

## 成本

最昂贵的步骤放在最后,发生频率也最低:

| 层级             | 决定内容                                                        | 成本     |
| ---------------- | --------------------------------------------------------------- | -------- |
| **代码**         | 空正文、未填写的模板、完全重复的内容、Reeve 已经处理过的 thread | 免费     |
| **一个廉价模型** | 这是否值得仔细阅读——垃圾信息、离题、超出范围                    | 极低     |
| **你选择的模型** | 真正的判定,针对存活下来的内容                                   | 真实费用 |

任何兼容 OpenAI 的端点都可以使用——OpenAI、网关、自托管模型、无需密钥的免费
层级——它们之间都不需要迁移。
[Cost](docs/guides/cost.md),含具体估算示例 ·
[Providers](docs/guides/providers.md)。

## 安全

Reeve 持有写入 token,读取陌生人写下的输入,并用一个该输入可能试图指使的模
型进行推理。这一设计并不要求某个 prompt 在与攻击者接触后依然安全——而是把
warrant 本身变成安全属性,以十条经过测试的不变量强制执行:不受信任的文本被
围栏隔离并作为数据加以框定,机器输出在发布前经过消毒处理,模型对自身权限的
任何说法都绝不会被采信。
[Security, stage by stage](docs/security/security.md) ·
[Threat model](docs/security/threat-model.md) ·
[Reporting a vulnerability](SECURITY.md)

## 文档

[`docs/`](docs/) 是完整索引,按读者身份组织:

| 如果你是……              | 从这里开始                                              |
| ----------------------- | ------------------------------------------------------- |
| Reeve 新手              | [Getting started](docs/getting-started/installation.md) |
| 正在决定是否采用它      | [The authority model](docs/concepts/authority-model.md) |
| 日常运行它              | [Guides](docs/guides/warrant.md)                        |
| 发现有什么不对劲        | [Troubleshooting](docs/guides/troubleshooting.md)       |
| 正在使用早期 `0.x` 版本 | [Migration](docs/guides/migration.md)                   |
| 正在从安全角度审查它    | [Threat model](docs/security/threat-model.md)           |
| 正在修改代码            | [Development](docs/development/README.md)               |

Reeve 处于 `0.x` 阶段,遵循 semver 的通常承诺:某个输入仍可能在一个 minor
版本中发生变化,发布说明会在这种情况发生时注明,并且每个发布版本都会锁定
`v0.$MINOR`——
[`0.x` 与 `1.0` 在这里的含义](docs/development/releasing.md#what-0x-and-10-mean-here)。

## 许可证

[Apache-2.0](LICENSE)。

---

<p align="center">
  <sub>
    Maintained by <a href="https://ecoma.io">Ecoma</a> ·
    <a href="https://ecoma.io">Website</a> ·
    <a href="https://github.com/ecoma-io">Github</a>
  </sub>
</p>
