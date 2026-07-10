<h1 align="center">Pokémon Champions Skills</h1>

<p align="center">
  <b>让 AI 用本地事实、当前环境与精确计算来查图鉴、算对位、审队伍和建队</b>
</p>

<p align="center">
  <img alt="skills" src="https://img.shields.io/badge/skills-4-blue"/>
  <img alt="modes" src="https://img.shields.io/badge/single%20%26%20double-supported-success"/>
  <img alt="query" src="https://img.shields.io/badge/query-offline--first-success"/>
  <img alt="languages" src="https://img.shields.io/badge/names-zh%20%7C%20en%20%7C%20ja-orange"/>
  <img alt="agents" src="https://img.shields.io/badge/Claude%20Code%20%7C%20Codex-Agent%20Skills-blueviolet"/>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green"/>
</p>

<p align="center">
  <b>环境快照</b> · M-4 / M-B · 截至 <b>2026-07-10</b>
</p>

<p align="center">
  <a href="README.md">English</a> | <b>中文</b> | <a href="README_ja.md">日本語</a>
</p>

---

这是一套面向 AI agent 的《宝可梦冠军》本地技能包。它同时提供四个可以独立触发的 Agent Skill：

- 查确定事实的对战图鉴；
- 查询当前或历史环境分布；
- 计算具体伤害、击杀、生存和速度线；
- 以完整审计流程建队、改队、诊断和调校。

四个 skill 在安装和路由层面并列存在。`pokemon-champions-team` 在处理整队任务时会编排另外三个事实 skill，但它不是把三者藏起来的“万能问答层”：纯图鉴、环境或单点计算问题仍会直接交给对应 skill。

所有查询默认读取随包发布的本地数据。系统的目标不是替 AI 制造一个“队伍强度分”，而是让它的事实、计算、假设和取舍可以被检查。

## 项目定位

| 它是什么 | 它不是什么 |
|---|---|
| 一套装进 Claude Code、Codex 等 agent 的本地技能 | 网页建队器或需要注册账号的在线服务 |
| 图鉴、环境、计算和真实队样本的结构化查询层 | 依靠模型记忆回答的百科聊天机器人 |
| 带合法性、证据、置信度和审计门的对战队伍辅助工作流 | 自动产出“客观最强队”的黑箱优化器 |
| 当前赛季/规则的可更新快照 | 永远实时、无需关注日期的线上数据库 |

脚本负责事实、计算和确定性检查；AI 负责理解你的目标、设计候选、权衡利弊并解释最终建议。这个分工是整套项目最重要的边界。

> [!NOTE]
> **数据范围仅限《宝可梦冠军》。**
>
> 四个 skill 对外支持的数据范围只限《宝可梦冠军》当前正式版本中已经上线的宝可梦、形态、招式、道具、特性与规则；可查询的历史 season 也只是《宝可梦冠军》自身的环境快照。这里不包含《宝可梦 剑／盾》《宝可梦 朱／紫》等正作系列的数据，也不收录尚未正式上线的内容。同名宝可梦或招式在正作与《宝可梦冠军》中可能有种族值、威力、特性、学习集或机制差异，所有查询与计算均以《宝可梦冠军》的现行数据为准。

## 四个 Skill 一览

| Skill | 最适合回答 |
|---|---|
| [`pokemon-champions-dex`](#pokemon-champions-dex) | “它是什么、会什么、这个名字对应谁？” |
| [`pokemon-champions-meta`](#pokemon-champions-meta) | “现在什么常见、通常怎么用、这期变了什么？” |
| [`ncp-damage-calculator`](#ncp-damage-calculator) | “这一击多少、能不能确一/扛住、谁更快？” |
| [`pokemon-champions-team`](#pokemon-champions-team) | “帮我组队、检查这队、怎么改、怎么选、怎么调 SP？” |

## `pokemon-champions-dex`

离线对战图鉴，负责全项目的名称归一和 Champions 规则事实。它查询宝可梦与形态、属性、种族值、特性、学习集、招式、道具、性格、Mega 石对应关系，并支持批量查询和多条件反查。

**它擅长：**

- 中文、英文、日文名称互认，包括常见别名和多语言 Mega 写法；
- 批量解析用户给出的队伍、持有列表和配招名称；
- 反查“谁会某招”“同时满足哪些属性/特性/速度条件”；
- 为 meta、calculator 和 team 提供统一 canonical 名称。

**它的边界：**图鉴命中只说明“存在、合法可学或具备该事实”，不代表环境常见，也不代表对战上值得采用。

可以直接问：

```text
烈咬陆鲨能学冰冻拳吗？
哪些妖精属性宝可梦会大地之力？
X喷的种族值和特性是？
目前宝可梦冠军的合法道具中包括突击背心吗？
```

## `pokemon-champions-meta`

离线优先的环境快照与查询 API，负责“当前环境里实际出现了什么”。它按 season、rule 和单打/双打分别提供使用率排名，以及招式、道具、特性、性格、队友和 SP 分布等详情面板。

**它擅长：**

- 单打或双打前排环境概览；
- 查询某只宝可梦的常见配置与搭档；
- 反查使用某招、某道具或某类配置的常见宝可梦；
- 比较单打与双打差异；
- 读取相对上一快照的事实变动报告。

**它的边界：**详情面板里的招式、道具、特性、性格和队友通常是各自独立的边际分布。不能把每一列第一名直接拼成一套“常见完整配置”，更不能把使用率当作强度证明。

可以直接问：

```text
当前 M-B 双打使用率前 20 是谁？
Mega 巨金怪在单打和双打的常用招式有什么差别？
本期相比上一期meta数据，有哪些宝可梦明显升降，常用道具发生了什么变化？
双打里常见的顺风手都有谁？通常和谁一起出现？
```

发行版根目录还附带三份单语环境工作簿：`<season>_<date>_{zh,ja,en}.xlsx`。它们包含单打、双打完整环境表和事实性更新报告；无需运行脚本即可浏览，使用率请以文件名和页首快照日期为准。

## `ncp-damage-calculator`

基于随包内置 NCP VGC Damage Calculator core 的 Champions 伤害与速度计算器。它处理具体攻击方、守方、招式、SP、性格、道具、特性、能力阶段和场地状态，返回完整伤害随机数、百分比、KO/生存结论与速度关系。

**它擅长：**

- 一次具体攻击的伤害区间与 OHKO/2HKO 线；
- 指定配置能否吃下一击；
- 两个完整速度状态的先后手比较；
- 顺风、戏法空间、围巾、天气等条件下的速度线；
- 为 team skill 的 matchup 与 tune 提供精确底层计算。

**它的边界：**计算成功不等于配置在 Champions 合法；它也不是完整回合模拟器，不会替你推演所有回复、状态、PP 和双方选择分支。未写明的配置与场地条件都属于假设，回答时应一并列出。

可以直接问：

```text
固执 32 攻 Mega 巨金怪的地震打这只 Mega 雷丘 Y 多少？
炽焰咆哮虎能不能保证吃下常见烈咬陆鲨的地震？
顺风下这两只谁先动？戏法空间里顺序会不会反过来？
我的这套 SP 还差多少才能过速目标？
```

## `pokemon-champions-team`

这是整队任务的专用 skill：建新队、补全队伍、审队、改队、合法性校验、对位分析、选出分析和 SP 调校都由它处理。它与另外三个 skill 并列发布，但在一次整队任务内部会把 dex 的规则事实、meta 的环境分布和 calculator 的精确计算组织成一条可审计工作流。

它不直接从一句话生成一支看似合理的队。真正的目标是：**在不把建队变成黑箱评分器的前提下，让 AI 从用户意图、当前环境、真实联合队伍和可复算对位出发，形成透明建议。**

> [!IMPORTANT]
> **它能提高建队回答的下限，不能替代高水平建队经验。**
>
> 这套 skill 能减少过时记忆、名称错配、非法配置、算错伤害、把环境边际误拼成完整 set、忘记用户约束等常见问题；它提高的是 AI 输出的**事实下限和推理纪律**。同一套 skill 由不同模型驱动，候选质量和解释深度仍会有明显差异。队伍是否真正适合你的打法、选出习惯、对手群体和临场计划，也取决于你提供了多少有价值的对战信息。

不要把第一次输出当成自动生成的最优答案。想得到更好的结果，请告诉 AI 你真正想实现的胜利方式、核心选出或首发思路、常遇到的对手、愿意接受的弱点、实战中输在哪里，以及你已经掌握的人类经验。最有效的用法通常是：先得到一份有数据依据的方案，实战或复盘后反馈具体问题，再让它继续改队和调线。

### 你可以怎样提供输入

没有指定文件名，也没有要求用户先学会某种 JSON schema。以下形式都可以：

- 直接说“围绕某只宝可梦组一队”；
- 粘贴 Showdown 风格队伍；
- 粘贴已有的 team JSON；
- 用自然语言逐只描述队员、配招和 SP；
- 指向本地任意文件中的队伍或持有列表；
- 提供一张清晰截图，让 AI 先读出内容；
- 只给限制条件，例如“只用我拥有的宝可梦”“保留这只 Mega”“不要空间”。

AI 会先用 dex 解析所有宝可梦、招式、道具、特性和性格，再把队伍事实、硬限制、软偏好和对位目标整理成可检查的结构化输入。清洗格式是 agent 的工作，不需要你处理。

### 能力地图

| 能力 | team skill 实际做什么 |
|---|---|
| **输入与合法性** | 读取自由文本、Showdown 或 JSON，规范名称与形态，并检查可用名单、学习集、特性、道具、同种/同道具限制、队伍规模、SP 和 Mega 关系；结果区分 `valid / invalid / unknown`。 |
| **队伍诊断** | 从防守属性、进攻覆盖、速度结构、速度控制和功能信号等维度列出事实与缺口，不给一个综合分。 |
| **对位与选出** | 按当前 meta top-K 计算双方伤害、速度和 KO 关系；分析单打 6 选 3、双打 6 选 4 与一场一次 Mega 等选出约束，不替用户宣布“最佳选出”。 |
| **SP 调校** | 把“扛住 X、过速 Y、确一/二确 Z”变成明确的对位目标，寻找跨过离散悬崖所需的最小 SP 和机会成本，而不是搜索一套“最优努力值”。 |
| **候选与真实队证据** | 根据缺口检索补位/替换候选，比较修改前后的客观差异，并用真实队的联合结构、代表 set 和完整样本帮助 AI 组装自己的方案。 |
| **结果检查** | 对候选使用同一套事实检查，拦截非法或违反硬约束的方案，并检查最终回答是否遗漏假设、取舍、调校说明或无法复算的数字。 |

### 它怎样完成整队任务

team skill 内部使用一套流程化约束来减少“先凭印象生成，再事后找理由”的问题。最终用户不需要理解各个内部算子；一次完整任务可以概括为四步：

1. **理解目标**：确认格式、核心、可用范围、硬限制、玩法倾向和必须满足的对位线；开放式建队会分批提问，已有队伍分析只补真正缺失的信息。
2. **用数据接地**：同时查看当前环境和真实联合队伍，区分“什么常见”与“哪些配置确实一起出现”，避免从独立使用率列里拼出虚构 set。
3. **比较候选**：生成一个或多个方向，使用同一套合法性、结构、对位和置信度检查，说明每个选择解决了什么、又付出了什么。
4. **验证后交付**：对需要的伤害、速度、选出和 SP 线做精确计算，复核最终文字中的数字、假设与取舍，再把结果交给用户继续判断和迭代。

流程保证的是依据可查、约束不容易丢、数字可以复算；它不会判断某种对战哲学一定正确，也不会把一支队认证为客观最优。

### 三种常见使用路径

| 你的请求 | 它会怎样处理 |
|---|---|
| **从零建队** | “建队流程”会进入完整引导；普通建队请求会按缺失信息分批询问，再给出经过比较和验证的方向。 |
| **审核或改队** | 直接整理现有队伍，先检查合法性和结构；涉及环境时补对位，需要换人时说明修改前后的收益与代价。用户要求保留的核心不会被顺手删掉。 |
| **选出、对位、调 SP** | 按问题分别做 6 选 3/4、完整环境对位或具体阈值调校；“当前能否扛住”和“请调到能扛住”不会混为同一种计算。 |

### 真实队样本怎样被使用

发行版内置按赛季、规则和单/双分区的真实队样本。它们提供的是**联合事实**：某六只是否共同出现、某成员的道具/特性/招式/性格/SP 是否来自同一套实际配置、哪些结构在特定证据等级中反复出现。

样本库不是排行榜：

- 战绩、名次、rating 和样本数不会被归一化成强度分；
- 单打和双打不混合，不同规则不会偷偷进入当前证据池；
- 只有物种列表的样本可用于共现，但不能冒充完整代表 set；
- 标准配置缓存始终是低置信参考，用户自己的队伍仍按实际配置现算；
- AI 可以阅读整队作为证据，但不能静默把库中某队原样回显成“推荐”；确实决定原样采用时，必须说明样本重叠事实、为什么适合，以及考虑过哪些修改。

### 怎样阅读 team 输出

**合法性不是二元猜测。** `valid` 表示已在当前可用事实上通过确定性检查；`invalid` 会给出具体错误；`unknown` 表示输入或底层事实不足，不能把“不知道”写成“合法”。

**使用率不是强度。** meta 排名、真实队共现和赛事标签只提供不同视角。AI 可以在解释取舍后推荐，但工具不会把它们合成一个不可审计的分数。

**CHECK 不是模拟器。** C2/C1/C0 基于指定 set、伤害、速度和回合预算。强化、回复、状态、PP 与长期消耗只在能力范围内检测和提示，不能把 C2 读成绝对 counter。

**置信度要和结论一起读。** 真实联合 set、边际 fallback、标准 set 缓存、样本过薄或部分计算失败会带不同 confidence 与 caveat。最终回答应把关键假设写出来。

### 可以直接这样提问

```text
建队流程：我想组一支 M-B 双打，先问我需要确认的内容。

围绕 Mega 姆克鹰做一支单打队，只要一支最终方案，但把关键取舍说清楚。

这是我的双打队伍，帮我检查合法性、结构短板和当前环境前 20 的对位，然后提出修改。

只使用 roster.txt 里我拥有的宝可梦组双打，保留耿鬼，不要戏法空间。

这六只双打通常应该怎么选四只？不同对手需要换哪条选出轴？

把我的炽焰咆哮虎调到能保证吃下指定烈咬陆鲨的地震，同时说明要牺牲什么 SP。

比较把队里 A 换成 B 前后的防守、速度控制和环境漏洞，不要只说谁更热门。

找出真实队库里包含这两只核心的结构，但不要直接复制整队，先总结共同点和变体。
```

## 四个 Skill 怎样协作

同一个问题可以触发多个 skill，但事实责任不会混淆：

```text
用户自由文本
  ├─ 名称、形态、学习集、道具是否合法 ──> dex
  ├─ 当前常见度、配置边际、搭档分布 ───> meta
  ├─ 指定条件下的伤害与速度 ──────────> calculator
  └─ 整队意图、候选、诊断、调校与审计 ─> team
                                      └─ 按需调用前三者
```

例如“围绕 Mega 巨金怪组一支双打，并保证它能吃下某只烈咬陆鲨的地震”会依次用到名称与合法性、当前环境、真实队结构、完整候选评估和伤害悬崖计算；而“Mega 巨金怪是什么属性”只需要 dex，不会进入建队流程。

## 安装

四个 skill 会一起安装。安装后不需要手工注册命令，agent 会根据每个 `SKILL.md` 的描述自动选择。

### 方法 A：一行命令

先安装 [Node.js](https://nodejs.org/)，然后在项目目录运行：

```bash
npx skills add pmwl0128/pokemon_champion_agent
```

全局安装到所有项目：

```bash
npx skills add pmwl0128/pokemon_champion_agent -g
```

安装器来自 [vercel-labs/skills](https://github.com/vercel-labs/skills)，会提示你选择可用 agent 与安装范围。注意：npx命令的链接安装方式当前版本在windows上会触发bug链接失败，推荐使用复制或手动链接。

### 方法 B：Claude Code 插件市场

在 Claude Code 对话框中输入：

```text
/plugin marketplace add pmwl0128/pokemon_champion_agent
/plugin install pokemon-champions@pmwl
```

### 方法 C：让 agent 安装

把下面这段交给有 shell 权限的 agent：

> 安装 https://github.com/pmwl0128/pokemon_champion_agent 中的四个 skill。Claude Code 使用 `.claude/skills/`，Codex 使用 `.agents/skills/`；安装到我的全局 skills 目录，并确认四个 `SKILL.md` 都能被发现。

### 方法 D：手动复制

```bash
git clone https://github.com/pmwl0128/pokemon_champion_agent.git
cp -r pokemon_champion_agent/.claude/skills/* ~/.claude/skills/   # Claude Code
cp -r pokemon_champion_agent/.agents/skills/* ~/.agents/skills/   # Codex
```

仓库中的 `.agents/skills/` 与 `.claude/skills/` 是逐字节一致的镜像，只需使用你的 agent 会扫描的那一份。

### 环境要求

- **Python 3.10+**：dex、meta 和 team 的查询脚本；日常查询只使用标准库。
- **Node.js**：NCP 伤害/速度计算器；方法 A 的 `npx` 安装器也需要。
- **openpyxl 3.1+（可选）**：只有自行运行 meta 的 `export-excel` 时需要；发行版已经附带工作簿。

### 更新

| 安装方式 | 更新方法 |
|---|---|
| `npx skills` | `npx skills update` |
| Claude Code 插件 | `/plugin marketplace update` |
| Git / 手动复制 | `git pull` 后重新复制对应 skills 目录 |

### 验证安装

确认 skills 目录中存在以下四个文件夹：

```text
ncp-damage-calculator
pokemon-champions-dex
pokemon-champions-meta
pokemon-champions-team
```

然后先问一句“烈咬陆鲨能学龙之舞吗？”，再问“帮我建一支单打队”。前者应触发 dex，后者应进入 team 的分批引导。

## 新手入门：建立自己的对战项目

skill 可以全局安装，但更推荐为自己的队伍建立一个独立项目目录：队伍、持有列表、复盘记录和 agent 指令都放在一起，后续改队时更容易持续积累上下文。

### 1. 创建项目目录

```bash
mkdir my-champions
cd my-champions
```

目录名可以任意。用 IDE 类 agent 时直接打开这个文件夹；使用 CLI agent 时先进入目录，再启动 Claude Code 或 Codex。

### 2. 安装四个 skill

按照上面的任一种 [安装方式](#安装)完成安装。项目级安装可以直接在当前目录运行：

```bash
npx skills add pmwl0128/pokemon_champion_agent
```

如果 Windows 上遇到链接安装失败，改用“让 agent 安装”或“手动复制”，把四个 skill 放入当前项目对应的 `.claude/skills/` 或 `.agents/skills/`。

### 3. 放置项目指令（可选但推荐）

发行版根目录附带 `CLAUDE.md` 和 `AGENTS.md`。可以把其中一个或两个放到自己的项目根目录：

- 使用 Claude Code 时优先放置 `CLAUDE.md`；
- 使用 Codex 或其他识别 `AGENTS.md` 的 agent 时放置 `AGENTS.md`；
- 同一个项目会由多种 agent 打开时，可以两份都保留。

它们会提醒 agent 区分四个 skill 的职责、读取当前环境、不要凭记忆回答事实，并在整队任务中遵守 team skill 的内置流程。skill 不依赖这两份文件才能运行，但对指令遵循能力较弱的模型尤其有帮助。

### 4. 放入自己的数据（可选）

你可以在项目里保存任意格式、任意文件名的个人资料，例如：

```text
my-champions/
  CLAUDE.md           # 可选
  AGENTS.md           # 可选
  roster.md           # 拥有的宝可梦
  current-team.txt    # Showdown 队伍或自然语言配置
  matchup-notes.md    # 实战记录、常见对手与改队想法
```

这些文件都不是固定格式。提问时告诉 agent 文件路径和使用方式即可，例如“只用 `roster.md` 里的宝可梦”“结合 `matchup-notes.md` 重新检查这支队”。agent 会先读取并清洗内容，再交给相应 skill。

### 5. 开始提问并持续迭代

在项目目录里启动 agent 后，可以从下面任一句开始：

```text
烈咬陆鲨能学龙之舞吗？
分析 current-team.txt 的合法性和环境对位。
只用 roster.md 里的宝可梦，帮我建一支单打队。
根据 matchup-notes.md 里的实战问题继续改队，不要动我指定的核心。
```

保留每轮队伍与复盘记录，会比每次从空白对话重新生成更容易得到贴近个人打法的结果。

## 模型调用与流程提示

skill 的自动触发依赖 agent 能正确理解 `SKILL.md` 并持续遵循其中的指令，它不是对所有模型都同样强制的运行时机制。部分工具调用能力或长任务指令遵循能力较弱的模型，可能会直接凭记忆回答、只调用其中一个事实 skill，或在建队时跳过部分内置流程。

遇到这类情况，可以在请求中显式指定：

```text
先读取 pokemon-champions-team/SKILL.md，再使用 team skill 完整处理这次建队请求。
这个结论不要凭记忆：名称和合法性查 dex，环境分布查 meta，伤害与速度调用 calculator。
请遵守 team skill 的内置建队流程，不要跳过候选比较、合法性检查和最终核验。
```

同时建议使用发行版附带的 `CLAUDE.md` / `AGENTS.md` 作为项目级指令。它们不能让模型自动获得更高的对战水平，但可以提高 skill 路由和流程执行的稳定性。若模型仍频繁忽略工具结果，换用工具调用与长指令遵循能力更强的模型通常比反复补救提示更有效。

## 使用建议

1. 在任意项目文件夹中启动 Claude Code、Codex 或其他兼容 Agent Skills 的 agent。
2. 直接用中文、英文或日文提问，不需要记 CLI 命令。
3. 队伍、持有列表和限制条件可以粘贴在对话里，也可以放在任意本地文件中并告诉 agent 路径；没有规定文件名。
4. 需要当前环境结论时留意页首 season/rule/as-of；需要更新时更新整个 skill 包。
5. 如果 agent 没有按预期调用技能，让它先读取对应 `SKILL.md`。发行版随附的 `AGENTS.md` / `CLAUDE.md` 也可以作为项目级工作规则使用。

## 环境工作簿

每次正式发行会从完整的单打、双打快照与更新报告重新生成三份工作簿：

```text
<season>_<date>_zh.xlsx
<season>_<date>_ja.xlsx
<season>_<date>_en.xlsx
```

每份文件只使用一种主语言；中/日版附英文 canonical 名称便于交叉检索。主要工作表包括：

| 工作表 | 内容 |
|---|---|
| 单打 / 双打 | 排名、名称、热门招式、道具、特性、性格、队友和 SP 分布 |
| 更新报告 | 相对上一快照的排名、新进/跌出与配置变化事实，以及名称联动检索 |

工作簿是 facts-only 报告，不包含 AI 对环境的主观解读。

## 数据时效与诚实边界

- meta 与 real-team 数据随环境变化；发行版只保证页首标注日期对应的本地快照，不声称实时。
- dex、meta、team 样本和计算器全部随包查询，日常使用不需要网络；获取新数据请更新 skill 包。
- 历史 season 可以查询，但旧规则不会静默混入当前规则证据池。
- 图鉴事实和伤害公式也可能随规则更新；跨规则问题必须明确 season/rule。
- 工具无法覆盖所有回合状态、隐藏信息和玩家选择。输出中的 assumption、confidence 与 caveat 是结论的一部分。

## 数据来源与致谢

发行版发布经过转换、校验和脱敏的查询数据与事实投影，不发布开发侧原始抓取缓存。主要来源包括：

### 环境排名与使用率

| 来源 | 用途 |
|---|---|
| [GameWith](https://gamewith.jp/) Pokémon Champions | 环境排名与招式、道具、特性、性格、SP、队友详情 |
| [PokeChamp DB](https://pokechamdb.com/) | 独立环境 feed 与交叉验证 |

### 对战图鉴、名称与计算

| 来源 | 用途 |
|---|---|
| [NCP VGC Damage Calculator](https://github.com/nerd-of-now/NCP-VGC-Damage-Calculator) | 核心实体数据与伤害计算引擎 |
| [Serebii.net](https://www.serebii.net/) Champions Pokédex | Champions 学习集、特性与招式先制度 |
| [52Poke / 神奇宝贝百科](https://wiki.52poke.com/) | 中日英显示名、别名与分形态资料 |
| [PokéAPI](https://pokeapi.co/) | 名称独立校验；不是 Champions 对战事实权威 |

### 真实队样本

| 来源 | 形式 | 用途 |
|---|---|---|
| [Yakkun / ポケモン徹底攻略](https://yakkun.com/) | 单打 | 完整联合配置与 SP |
| [OP.GG](https://op.gg/) Pokémon Champions | 单打 | 复刻队伍与 SP |
| [GameWith](https://gamewith.jp/) / [Game8](https://game8.jp/) | 单打 | 已结束赛季的上位构筑事实 |
| [Limitless TCG](https://play.limitlesstcg.com/) | 双打 | 线上赛事队伍、战绩与名次 |
| [VGCPastes / Pokepaste](https://pokepast.es/) | 双打 | 社区整理的完整队伍与 SP |

感谢这些项目、站点、赛事组织者和社区贡献者公开数据与工具。来源中的排名、战绩和队伍只作为事实证据使用，不代表本项目对其强度作背书。

## 许可

`ncp-damage-calculator` 内置 NCP VGC Damage Calculator 公式；上游许可保留在 skill 的 `references/upstream-LICENSE`，并在 `NOTICE` 中说明。本发行版其余许可见 `LICENSE`（MIT）。

> Pokémon 及角色名称为 Nintendo / Creatures Inc. / GAME FREAK inc. 的商标。本项目是非官方同人工具，与上述公司无关，也未获其背书。
