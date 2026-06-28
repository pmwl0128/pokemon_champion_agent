<h1 align="center">⚔️ Pokémon Champions Skills</h1>

<p align="center">
  <b>给 AI 智能体的《宝可梦 冠军赛》对战数据底座 —— 基于事实与精确计算</b><br/>
  <i>Battle-data skills for AI agents — based on facts and exact calculations for Pokémon Champions.</i>
</p>

<p align="center">
  <img alt="skills" src="https://img.shields.io/badge/skills-3-blue"/>
  <img alt="format" src="https://img.shields.io/badge/Champions-Reg.%20M--B-8A2BE2"/>
  <img alt="modes" src="https://img.shields.io/badge/single%20%26%20double-supported-success"/>
  <img alt="offline" src="https://img.shields.io/badge/offline--first-yes-success"/>
  <img alt="agents" src="https://img.shields.io/badge/Claude%20Code%20%7C%20Codex-Agent%20Skills-orange"/>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green"/>
</p>

<p align="center">
  📅 <b>环境数据 / Metagame data</b> · M-3 / M-B · 截至 / as of <b>2026-06-27</b>
</p>

---

> 一组即插即用的轻量级 **Agent Skill**，把《宝可梦 冠军赛》（Regulation **M-B**，单打 & 双打）的
> 图鉴、环境使用率、伤害/速度计算、建队辅助(indev)搬进你的 AI 助手。脚本只输出**可验证的事实**和**精确计算**，并标注
> 每条结论的依据与所属赛季/规则
>
> A set of lightweight, drop-in **Agent Skills** that bring the battle dex, metagame usage,
> damage/speed math, and team-building help (in dev) for **Pokémon Champions** (Regulation **M-B**,
> single & double) into your AI assistant. The scripts emit only **verifiable facts** and **exact
> calculations**, each tagged with its evidence and the season/rule it was computed for.

## ✨ 亮点 / Highlights

- 🔌 **即插即用 / Drop-in** — 兼容 [Agent Skills 标准](https://agentskills.io)：**Claude Code**、**OpenAI Codex** 等都能自动识别，无需注册。
- 📴 **离线优先 / Offline-first** — 查询走本地缓存，断网也能用；联网只为刷新环境数据。
- 🌏 **三语别名 / Trilingual** — 中文 / English / 日本語 名称互查，支持反向多条件检索。
- 🎯 **基于事实 / Facts only** — 命中/生存/抢速等阈值用真实公式现算，带 evidence + 置信度，不下"最优"结论。
- 📊 **环境快照工作簿 / A ready-to-read workbook** — 随包附带一份 Excel：环境一览 + 变动报告 + AI 解读（见下）。
- 🔗 **三技能联动 / Better together** — 图鉴出事实、环境出使用率、计算器出伤害与速度；一个问题里 AI 会自动把三者串起来（比如「按当前环境前排，算我的烈咬陆鲨对位」会同时用到三个）。 / *Dex gives facts, meta gives usage, the calculator gives damage & speed — the agent chains all three within a single question.*
- 🛠️ **建队辅助即将开发完成 / Team-builder almost ready** — 第四个 skill 基于上述三者做合法性校验、诊断、对位、SP 微调与候选检索（开发中）。 / *A fourth skill builds on these three for legality checks, diagnostics, matchup, SP tuning, and candidate retrieval (in dev).*

## 🧩 三个技能 / The three skills

| Skill | 中文 | English |
|---|---|---|
| **`pokemon-champions-dex`** | 对战图鉴：宝可梦/形态、三语名、属性、种族值、特性、招式表、道具、Mega 石，批量与多条件反查。离线优先。 | Battle dex: roster/forms, trilingual names, types, base stats, abilities, learnsets, items, Mega stones, batch + multi-condition reverse search. Offline-first. |
| **`pokemon-champions-meta`** | 环境缓存与查询：使用率排名、详情面板（招式/道具/特性/性格/队友/SP 努力值）、单双对照，按赛季/规则。可刷新。 | Metagame cache & query: usage rankings, detail panels (moves/items/abilities/natures/partners/SP spreads), single-vs-double, per season/rule. Refreshable. |
| **`ncp-damage-calculator`** | 伤害区间、击杀/生存阈值、速度线，使用内置 NCP VGC 公式。 | Damage ranges, KO/survival thresholds, and speed lines using the bundled NCP VGC formulas. |

> 🛠️ **第四个也是最核心的 Skill 即将完成 / The fourth — and most central — skill is nearly ready** —— 一个基于以上三者的**建队编排器**：
> 它把图鉴的事实、环境的使用率、计算器的伤害/速度串起来，做合法性校验、诊断、对位、SP 微调与候选检索，
> 功能完整后会加入本仓库。
> *A team-building **orchestrator** that chains the three skills above (dex facts + meta usage + damage/speed) for legality checks, diagnostics, matchup, SP tuning, and candidate retrieval — added once feature-complete.*

## 📊 环境快照工作簿 / The metagame workbook (`<season>_<date>.xlsx`)

仓库根目录附带一份最新的环境数据易读版 Excel，快速把握当前环境，无需运行任何脚本：
*A ready-to-read Excel ships at the repo root — grasp the current metagame at a glance, no scripts needed:*

| 工作表 / Sheet | 内容 / Contents |
|---|---|
| **单打 / 双打** | 每只一行：名次、中/英名、热门招式·道具·特性·性格·队友、SP 努力值分布。<br/>*One row per Pokémon: rank, names, top moves · items · abilities · natures · partners, SP spread.* |
| **更新报告 / Update report** | 相对上一份快照的**事实性变动表**（名次升降、新进榜、跌出榜、配置变动）＋ 一个**中文名联动检索**（单/双对照）＋ 一块 **AI 环境解读**（对本期变动的AI生成判读，不保证准确性仅供参考）。<br/>*Factual change tables vs the previous snapshot (rank shifts, new/dropped, config changes) + an interactive 中文名 lookup (single/double) + an **AI-generated metagame read** of what changed (for reference only — accuracy not guaranteed).* |

> 工作簿随环境刷新重建；使用率是时效数据，请以最新一份为准。
> *The workbook is regenerated as the metagame refreshes; usage is time-sensitive — trust the latest.*

## 📥 安装 / Install

> 🔰 **新手指南**：下面四种方法**任选其一**，从最省事到最手动。装好**不用注册**——技能靠各自 `SKILL.md` 的描述自动触发。拿不准就用**方法 A**。
> *Beginner-friendly: pick **any one** method below, easiest first. No registration — skills auto-trigger from their `SKILL.md`. Unsure? Use **Method A**.*

### 方法 A · 一行命令（优先推荐）/ Single command (recommended)

需要先装 **[Node.js](https://nodejs.org/)**。这条命令会**自动识别你装了哪个助手**（Claude Code / Codex / Cursor 等）并装到对应目录，一次把三个技能都装好：
*Install **[Node.js](https://nodejs.org/)** first. This auto-detects your agent(s) and installs all three skills to the right place:*

```bash
npx skills add pmwl0128/pokemon_champion_agent        # 项目级（在你项目目录里运行）/ project scope
npx skills add pmwl0128/pokemon_champion_agent -g      # 全局（所有项目都能用）/ global
```

> 🟢 **还没装 Node.js？** 到 [nodejs.org](https://nodejs.org/) 下载 **LTS** 版一路下一步即可；或用包管理器：macOS `brew install node`、Windows `winget install OpenJS.NodeJS`、Linux 用你发行版的包管理器。装好后终端运行 `node -v` 能看到版本号就 OK。
> *No Node.js yet? Grab the **LTS** build from [nodejs.org](https://nodejs.org/), or use a package manager (`brew install node` / `winget install OpenJS.NodeJS` / your distro's). Run `node -v` to confirm.*
>
> 安装器来自 [vercel-labs/skills](https://github.com/vercel-labs/skills)。第一次运行会让你确认，跟着提示按回车即可。
> *Powered by [vercel-labs/skills](https://github.com/vercel-labs/skills); follow the prompts on first run.*

### 方法 B · Claude Code 插件市场 / Claude Code plugin marketplace

用 **Claude Code** 的话，在它的**对话框里**输入这两行（是在 Claude Code 里输入，不是终端）：
*With **Claude Code**, type these two lines **inside Claude Code** (not your terminal):*

```text
/plugin marketplace add pmwl0128/pokemon_champion_agent
/plugin install pokemon-champions@pmwl
```

> 这种方式带**自动更新**：以后一句 `/plugin marketplace update` 就更新到最新。
> *This path has **automatic updates** — later just run `/plugin marketplace update`.*

### 方法 C · 让 AI 帮你装（从 GitHub）/ Ask your agent to do it (from GitHub)

完全不想碰命令行、也没装 Node.js？把下面这段发给有命令权限的 AI 助手，让它**直接从 GitHub 装**：
*No terminal, no Node.js? Paste this to an agent with shell access — it installs **straight from GitHub**:*

> 帮我安装这个仓库里的技能：把 https://github.com/pmwl0128/pokemon_champion_agent 克隆下来，然后把里面 `.claude/skills/` 下的三个技能文件夹拷进我的 `~/.claude/skills/`（如果我用 Codex 就把 `.agents/skills/` 拷进 `~/.agents/skills/`），装完告诉我装了哪几个。
> *"Install the skills from https://github.com/pmwl0128/pokemon_champion_agent: clone it, then copy the three skill folders under `.claude/skills/` into my `~/.claude/skills/` (or `.agents/skills/` → `~/.agents/skills/` for Codex). Tell me which ones got installed."*

### 方法 D · 手动复制 / Manual copy

先克隆仓库，再把技能文件夹拷进你助手扫描的 skills 目录（三个装进**同一个**目录——meta 会用到 dex 的别名）：
*Clone the repo, then copy the skill folders into your agent's skills directory (all three into the **same** dir):*

```bash
git clone https://github.com/pmwl0128/pokemon_champion_agent.git
cp -r pokemon_champion_agent/.claude/skills/*  ~/.claude/skills/    # Claude Code（全局/global）
cp -r pokemon_champion_agent/.agents/skills/*  ~/.agents/skills/    # OpenAI Codex（全局/global）
# 项目级：改拷到你项目下的 .claude/skills 或 .agents/skills
# (project scope: copy into your project's .claude/skills or .agents/skills instead)
```

> 本仓库同时提供 `.agents/skills/`（Codex 等）与 `.claude/skills/`（Claude Code）两份**逐字节一致**的镜像，用你助手能发现的那份即可。
> *Both mirrors are byte-identical — use whichever your agent discovers.*

### 🔄 更新 / Updating

| 你的装法 / Installed via | 更新命令 / Update command |
|---|---|
| 方法 A（npx skills） | `npx skills update`（更新单个：`npx skills update pokemon-champions-dex`）|
| 方法 B（Claude 插件） | 在 Claude Code 里输入 `/plugin marketplace update` |
| 方法 C / D（手动） | 重新 `git pull` 后重新复制，或让 AI 再做一遍 |

### ✅ 验证安装 / Verify it worked

随便问一句需要数据的问题，比如「**M-B 双打最常见的空间手有哪些？**」——助手能用上技能、给出带数据的回答就说明装好了。也可以确认你的 skills 目录下出现了 `pokemon-champions-dex`、`pokemon-champions-meta`、`ncp-damage-calculator` 三个文件夹。
*Ask a data question (e.g. "most-used M-B doubles Trick Room setters?") — a data-backed answer means it works. Or check the three folders exist in your skills directory.*

### 环境要求 / Requirements
- **[Node.js](https://nodejs.org/)** —— 方法 A 的安装器 + 伤害计算器都需要。 / *needed for the Method-A installer and the damage calculator.*
- **Python 3.10+** —— dex/meta 查询脚本（查询期仅用标准库）。 / *dex/meta query scripts (stdlib-only at query time).*

## 💬 怎么用 / How to use

### 🔰 从零到第一个回答（新手分步）/ From zero to your first answer

1. **建一个项目文件夹**（你的"队伍工作台"，AI 会在这里读写）/ *Make a project folder — your agent reads/writes here:*
   ```bash
   mkdir my-champions && cd my-champions
   ```
2. **装上技能**（见上面 [安装](#-安装--install)；新手就在这个文件夹里跑方法 A）/ *Install the skills (Method A, run inside this folder):*
   ```bash
   npx skills add pmwl0128/pokemon_champion_agent
   ```
3. **在这个文件夹里启动你的 AI 助手**（Claude Code / Codex…），用大白话提问（例子见下）。 / *Start your agent in this folder and ask in plain language (examples below).*
4. **（可选）放一份你自己的"宝可梦/队伍清单"** / *(Optional) keep your own roster/team list:* 在文件夹里建个 `my_pokemon.md`，一行一只你拥有的宝可梦；提问时加一句「只用我清单里的」，AI 就会围绕你的宝可梦回答。等第四个建队 skill 上线后，这份清单还能直接用来校验/诊断你的队伍。
   *Create `my_pokemon.md`, one owned Pokémon per line, and say "only from my list" — the agent will build around them. Once the team-builder skill lands, this list also feeds legality checks and diagnostics.*

### 提问示例 / Example prompts

使用自然语言问你的AI助手，它会从各技能的描述里自动挑选合适的那个，常见的别名AI会自动识别：
*Ask your agent naturally — it picks the right skill from each skill's description and recognizes common aliases:*

- 「烈咬陆鲨能抵抗什么属性？」 / *"What does Garchomp resist?"*
- 「M-B规则双打最常用的空间手有哪些？」 / *"Which Trick Room setters are most-used in M-B doubles?"*
- 「魔幻假面喵能过速环境中的多龙巴鲁托吗？」 / *"Does Meowscarada outspeed Dragapult in the meta?"*
- 「炽焰咆哮虎能吃下常见配置烈咬陆鲨的地震吗？」 / *"Does Incineroar survive a common Garchomp's Earthquake?"*
- 「会大地之力、又是妖精属性的宝可梦有哪些？」 / *"Which Fairy-types learn Earth Power?"*（反查 / reverse search）
- 「Mega 妙蛙花在 M-B 双打的常见努力值(SP)怎么配？」 / *"Mega Venusaur's common SP spread in M-B doubles?"*

也可以问需要三个技能配合才能答的问题，AI 会把它们串起来：
*Or ask something that needs all three skills — the agent chains them:*

- 「按当前环境双打使用率前 30，帮我大致过一遍烈咬陆鲨的对位和互相伤害关系」 / *"Against the current top-30 doubles by usage, walk Garchomp's matchups and mutual damage."*（环境 → 图鉴 → 计算器 / meta → dex → calc）
- 「现在哪几只常见快攻手能在顺风下过速我的 Y 喷，其中哪些常见配置能一确我？」 / *"Which common fast attackers outspeed my Charizard-Y under Tailwind, and which of their common sets guarantee the OHKO on me?"*

> 等第四个**建队 skill** 上线后，你还能让它校验队伍合法性、诊断短板、给出对位与 SP 微调建议——而这些判断全都建立在上面三个 skill 的事实数据之上。
> *Once the team-builder skill lands, you'll be able to validate legality, diagnose gaps, and get matchup / SP-tuning advice — all grounded on the three data skills above.*

随包的 `AGENTS.md` / `CLAUDE.md` 是可选的入门提示模板，拷到你的项目根目录可强化"**查事实先调技能、别凭记忆作答**"，可根据具体需要自行编辑修改。
*The optional `AGENTS.md` / `CLAUDE.md` are drop-in starters that reinforce "call the skills for facts, don't answer from memory" — edit them to fit your needs.*

## 🔄 数据时效 / Data freshness

环境数据和队伍信息实时变化，`pokemon-champions-meta` 内置了当前赛季/规则的缓存快照——**使用率是时效数据**，本仓库会跟随刷新，有需要时请更新skill。
图鉴事实（属性、种族值、招式表）在一个规则周期内是稳定的。
*The metagame and team data shift constantly; `pokemon-champions-meta` ships a cached snapshot for the current season/rule — usage is **time-sensitive**, this repo refreshes it, and you can update the skill when you need the latest. Battle-dex facts (types, stats, learnsets) are stable within a regulation.*

## ⚖️ 许可与致谢 / License & attribution

`ncp-damage-calculator` 内置了 **NCP VGC Damage Calculator** 的公式；其上游许可保留在
`.agents/skills/ncp-damage-calculator/references/upstream-LICENSE`，并在 `NOTICE` 中说明。本分发条款见 `LICENSE`（MIT）。
*The damage skill bundles the NCP VGC Damage Calculator formulas (upstream license preserved in the skill + `NOTICE`); this distribution is MIT — see `LICENSE`.*

> 宝可梦及角色名称为 Nintendo / Creatures Inc. / GAME FREAK inc. 的商标。本项目是**非官方的同人工具**，与上述公司无关，也未获其背书。
> *Pokémon and character names are trademarks of Nintendo / Creatures Inc. / GAME FREAK inc. This is an unofficial fan-made tool, not affiliated with or endorsed by them.*
