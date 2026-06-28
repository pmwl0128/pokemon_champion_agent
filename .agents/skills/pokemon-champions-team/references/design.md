# Pokemon Champions 建队 Skill — 设计文档 (v3)

> v1 2026-06-19 → v2（整合外部审计）→ v3（产品边界澄清：只服务当前环境 / 道具池=dex / real-teams 不拆 / 前端独立）。
> 面向实现者与审计者。配套：同目录 `schema.md` / `SKILL.md`；开发现状与待办见 `dev/team_skill_dev.md`。
> ⚠️ = 已知局限/待审计点。**v3 变更摘要见 §14。**

---

## 0. 头号风险 + 工作边界

**头号失败模式**：从"事实工具"滑向"隐式评分/推荐系统"。real-teams 库、performance、候选排序、代表 set
缓存都可能悄悄变成"强度代理"。第一约束：

> **任何会被解读为"这队/这只更强"的综合排名或单一推荐，都禁止由 skill 产出。**
> skill 给客观事实 + **多个显式视图**；合并取舍是 AI 的事，AI 也不得替用户合并成单一推荐。

**工作边界（v3 澄清）**：skill **只服务当前环境**（当前 season/rule）。它假定看到的底座（dex/meta/ncp）
**永远是当前的**——底座更新是各自 skill 的事，**本 skill 不做数据过期/版本对齐的工作**。不存在"在 M-C 下
推荐 M-B 队伍"的场景。历史数据留档、可显式参考（§4），但默认只用当前。

---

## 1. 目的与范围

辅助 Pokemon Champions **单/双打**建队（**当前规则**）。辅助不代替：提供客观事实与计算，创造与权衡留给 AI。
覆盖：解析、合法性校验、队伍诊断、对抗分析、候选检索、真实队伍查询展示。

非目标：队伍强度总分；ML 胜率；遗传算法出整队；RAG 文本检索；任何综合排名；跨规则推荐。
**前端是独立项目，不在 skill 内开发**——skill 只保证干净的标准 json I/O 以便对接（§12）。

---

## 2. 设计哲学与能力边界

skill = 无状态脚本 + 数据，被 AI 在一个 turn 内调用。

> **skill 是 AI 的感官、计算器与记忆，不是大脑。**

**三分离 + 一禁止**：诊断/候选检索/决策(=AI) 分离；禁止综合评分/单一推荐。
状态由 AI 持有，`team-json` + `build-context` 每次传入；skill 不持会话状态。

| skill 做 | AI 做 |
|---|---|
| 精确事实、精确计算、确定性校验、穷举检索、真实数据查询 | 理解意图、选核心、权衡、解释、迭代、呈现多视图但不合并成单一推荐 |

---

## 3. 架构总览

```
   ┌──── 三个事实底座（当前环境，不重复存储） ────┐   ┌─ 可选样本库（独立、默认不参与诊断/排序）─┐
   │ dex(能是什么/学什么·道具池)  meta(配/usage)  │   │ real-teams: 整队模板+战绩元数据             │
   │ ncp(伤害/速度/KO)                            │   │ 采集在 dev/update/team/；留在 team skill 内     │
   └───────────────┬──────────────────────────────┘   └──────────────┬────────────────────────────┘
   输入: team-json(含 completeness) + build-context(意图/约束)   (仅 L4 templates/query 使用)
                   ▼
   ┌── 算子（无状态·吃部分队伍·输出带 evidence+置信度+reason） ──┐
   │ L1 体检   L2 对抗(按需 ncp,无缓存)   L3 候选(多视图+diff,无综合排名)   L4 真实队伍(仅查询) │
   └────────────────────────────────────────────────────────────────────────────────────────────┘
                   │  AI 在显式迭代循环里编排（§11）   ◀── 可经标准 json I/O 与独立前端对接（§12）
```
缓存层与代表 set 是后期（§9/§10）。

---

## 4. 事实底座（三个）+ 可选样本库

1. **dex**：roster/types/stats/abilities/learnset/Mega 石/**道具池(items)**/名称。**battle facts 与道具池的权威。**
2. **meta**：usage 排名、单只面板、partners。
3. **ncp**：伤害/KO/速度。
4. **real-teams（可选样本库，非底座）**：整队 cores/role/archetype + 战绩元数据。独立的时效性数据产品
   （采集/清洗/去重/来源可信度），管线在 `dev/update/team/`。
   - **默认不参与 L1 诊断,也不参与任何综合/强度排名**(§0 不变)。但**可作 L3 的显式事实视图**——
     `fill` 的**共现 / 大赛样本计数**就是真实队伍派生的独立排序视图(§6 L3 已列),那是客观事实排序、**不是强度分**;
     以及 **L4** 的查询/展示。换言之:real-team 进 L3 的是"事实视图",禁的是"把它合成强度排名/单一推荐"。
   - **留在 team skill 内，不拆独立 skill**（其数据在别处几无复用需求——产品决策已定）。也不并入 meta（语义不同）。
   - 历史 season 留档；当前环境数据稀少时（如规则刚切换），AI 可**显式**参考上一规则迁移性，但须标注历史、
     不作当前事实、不默认。

---

## 5. 输入：team-json + build-context + completeness

- **team-json**（schema.md §1）：队伍。每成员带 **completeness**（§8）。
- **build-context**（schema.md §7）：AI 把对话意图**翻译成的结构化约束**——locked/owned_only/wants(天气等)/
  keep_mega/单双/season-rule-format。⚠️ 是结构化约束，**不是让 skill 理解自然语言**。
- 诊断部分队伍时，context 告诉算子"哪些锁定、缺口在什么约束下补"。

---

## 6. 算子层（L1–L4）

无状态、吃 1–6 只、输出 `json`+`md`，每段带 evidence + 置信度 + reason（§7）。

- **L1 体检**：validate（§8）；defense（抗/弱/免、弱点集中度）；offense（覆盖按可靠性分级：hard gap/thin/
  centralized 点名/positioning-dependent）；speed（上下文化：顺风/空间/围巾/天气 + 速度控制 + 先制攻击招 dex `priority`）；
  roles（角色覆盖/缺口/compression；双打追加搭档增益 `partner_support` / 阵营保护 `side_protect`）。
  > 数据源说明：每只的 types/abilities/stats 取自 **dex**；但 **18×18 类型相性矩阵 dex 不提供**（dex 只支持
  > "查某类型的宝可梦"，无 type×type 倍率查询）。相性矩阵是**规则常量**，由 **skill 内置**（不是会更新的战斗数据，
  > 不违反"不重复存储"）。defense = dex.types + 内置相性表 + 免疫/减伤特性（飘浮/各吸收/食草/食土/厚脂肪/
  > 耐热/水泡/洁净之盐/毛茸茸 + Filter/Solid Rock 超效×0.75）+ 18 个半减树果（附注式、一次性、不改分类）。
  > ⚠️ **已知边界（明确不做）**：类型层表达不了的减伤——物理/特殊减半（Fur Coat/Ice Scales）、HP/状态条件
  > （Multiscale/Marvel Scale）、招式类免疫（Bulletproof/Soundproof/Overcoat）——**不在 defense 建模**，
  > 需精确数值时走 **ncp**（L2）。这条边界把"类型层诊断"和"伤害计算器"清晰分开。
- **L2 对抗**（按需 ncp，无缓存）：selection/matchup（vs 指定对手 或 meta top-K，6v6：类型×速度×最大伤害，
  learnset 过滤、双打修正，用户侧用实际 set）；meta-pressure；**tune/benchmark（SP 微调 = 悬崖探测，完整规格见 §16）**。
- **L3 候选**（检索，禁止综合排名）：fill（结构化缺口 → 候选池，**多显式排序视图**：usage/共现/大赛样本/近期/owned）；
  **replace-impact diff**（替换候选的客观 before/after 事实差，不选最佳、不下单一结论）。
- **L4 真实队伍**（仅查询展示）：templates（含某核心的真实队 + performance 标签）；synergy（真实共现）。
  ⚠️ 不进 L1 诊断,也不转**综合/强度排名**；但其**客观事实视图**(共现/样本计数)可作 L3 的显式排序之一(见 §4 / §6 L3)。performance 仅作展示标签,不转强度分。

---

## 7. 横切：evidence / 置信度 / 单双 / owned

- **evidence schema**（schema.md §8）：诊断/候选/关键 calc 输出自带 evidence（事实来源 + 计算输入 + 引用值）。
  ⚠️ 轻量输出侧 evidence，**不是** champions-data 的 claims-json 重协议（不强制 AI 产出格式 + retry）。
- **置信度 + reason**：high/medium/low + 为什么低（`small-sample`/`sp-inferred`/`cache`/`heuristic-role`/`vs-standard-set`）。
- 单/双差异贯穿；真实数据/缓存/代表 set **永不跨单双合并**。
- owned：读 `pokemon_owned.md`，fill 候选限定。

---

## 8. 规则与合法性

**权威来源分工**：
- **dex** = battle facts + **道具池** 的权威：roster、learnset、ability、Mega 石、种族值、**items（可持有道具池）**。
  ✅ v3 修正：道具池就是 `dex.items`，**不新建道具清单、不引入外部"M-B 缺失道具"清单**（那种清单多是 M-A、不可信）。
- **登录期规则常量**（报名规模 3–6、SP 32/66、Species/Item Clause、Mega 形态↔石头匹配）：少量常量，
  **已硬编码在 validator**（如 dex/meta 把规则常量内联的做法）。⚠️ 若未来规则常量变多/易变，再抽成一个按
  `(season,rule)` 的轻量常量模块；目前无需独立 rules source。
- ⚠️ **2026-06-19 修正：「Mega 一次」不是登录期规则**。Champions 是 6 选 3（单）/ 选 4（双），登录队带多块超进化石
  **完全合法且主流**，只是选出后仅一只能 Mega。"一次 Mega"是**选出/对战期**约束，归 **L2 selection**（M2/M3），
  **validate 不再拦截队伍级多 Mega**。同源约束由 Species Clause 覆盖（两只同种本就非法，自然带不了同种的 X/Y 两石）。

**completeness 分级**（schema.md §1）：`observed_full_set`/`observed_species_only`/`extracted_set`/`inferred_set`，
防半结构化单打样本污染 templates/synergy。

**validate 现状**（M1 已实现并测过，2026-06-19 起带 hermetic pytest）：roster/learnset/ability + **道具池
（item ∈ dex.items）** + Species/Item Clause + SP 32/66 + 规模 + **Mega 形态↔石头匹配**（仅当成员以 Mega 形态名给出时）。
测例命中：Incineroar 无法学 Knock Off、假道具被拦、Item Clause 撞车、双超进化石**合法放行**、
Charizard + Mega Charizard X 经修正后的 dex base_species **正确同源冲突**。

---

## 9. 缓存层（后期；时效跟随环境，不做版本对齐）

✅ v3 简化（产品边界："不思考数据过期"）：缓存**只服务当前环境**，由 `dev/update/` 在底座更新/规则切换时**重建**；
query **假定缓存即当前**，**不在 query 时做多维版本检测**。缓存只带一个轻量 `built_for`（season/rule/format/built_at）
用于重建判断与 debug，**不需要** dex/meta/ncp/repset/snapshot 五维对齐（那是被本边界推翻的过度设计）。

其余同前：M1–M4 不做缓存，L2 一律按需 ncp 现算；M5 再加（meta top-K 代表 set 两两矩阵，几百 KB，
比 champions-data 5–12MB 瘦 1–2 数量级）；cell 一律 `low` 置信（reason=`vs-standard-set`），用户侧用实际 set 现算。

> **M5 step 2（2026-06-25 落地）**：`scripts/oppcache.py`（读侧 + 纯 `build_matrix`，事实塑形复用 matchup 的
> KO 桶 / cliffs 速度）+ dev 构建器 `dev/update/team/cache.py`（接 metalink 用法排名 + sources 解析 + ncp 批量伤害，
> 写 `data/opponent_cache/<season>_<fmt>.json`，随发布、由 `update.py team-cache` 重建）+ CLI `team.py oppmatrix
> [species] --game-format single|double [--vs def]`。每 cell = 攻方最硬招(按高 roll) vs 守方标准 set 的伤害带/KO桶
> + 模态速度线；**全 cell `low` 置信 reason=`vs-standard-set`**。**按格式分设 top-k:单打 50 / 双打 60**（两 meta
> 真实数据密度差 ~50x——双打 60 行全真实backed,单打现 ~36 真实 + 余为守方、留赛季增长 headroom）。产物单打 ~1.7MB / 双打 ~3.1MB
> （已超原"几百 KB"设想,但缓存是**按需读的数据文件、不进上下文**,与 dex/meta 缓存同量级,可接受）。
> **关键纪律（§15 Q5 的字面落地）**：**攻方行仅给真实队backed物种**（样本≥`MIN_SAMPLE`，有真实联合 4 招集）——
> meta-only 物种无真实联合招集（meta 边际拼招正是 §10 陷阱①所禁），故只作守方（被打只需耐久 bulk）。这就是"仅为过
> `MIN_SAMPLE` 物种建 cell"：单打 60 队下 **29/30** 物种有攻方行（仅 Glimmora 真薄、留守方），双打 2879 队 30/30 全有。
> 这是**参考网格、不是用户队伍**——用户真实队伍恒用 `matchup` 现算实际 set（陷阱⑤双打搭档模糊由 cell low 置信兜底）。
>
> **两处审计修复 + 一处自动化（2026-06-25）**：
> ① **单打 Mega 名错位**（与 step1 F1 同源、但当时只验了双打）：meta 把单打 Mega 排在**基础名**（`Staraptor`/`Metagross`），
> 真实库按 op.gg/yakkun 归一存成 `Mega X`（`Mega Staraptor` 8 队等），直接拿基础名查 → 误判"无真实数据"。修法 `repset.dominant_form`：
> 基础名解析到它**实际被使用的形态**（某 `Mega <base>` 真实队backed 且≥基础形态数 → 用该 Mega）。**修在共享 resolver**
> （`sources._rep_for` 查库前先 `dominant_form`、merged set 带 `run_form`），所以 **`matchup` 也一并修好**——用 `run_form` 取 Mega 的
> 属性/速度/伤害基底。矩阵/对位仍按 meta 名作键、`run_form` 透明标真实形态。单打攻方行 16→**29**。
> ② **画皮后门**（用户要求）：谜拟Q cell 于"特性==画皮"守方加 `disguise_adjusted`。**有效击杀 = 1 回合(招式被画皮完全挡掉、谜拟Q
> 破皮自损 1/8 HP → ~87.5%) + ceil(剩余 87.5% ÷ 每回合伤害)**——**不是粗暴的名义+1**（硬招配 1/8 破皮自损可能更快 KO、弱招也可能落名义档）。
> **标注层具名特例、不重算引擎**（§7 禁线：披带/结实/画皮… 不进通用 KO 引擎，否则斜坡=重写引擎）。
> ③ **自动重建**：缓存是 meta/dex/ncp 底座的**派生物**，`update.py {meta,dex,ncp,all}` 刷新后**自动重建一次**（`--no-cache` 关闭）、纯本地不联网。

---

## 10. 代表 set 算法（M5 step 1 查询 + step 2 缓存均已落地）

每个 set 强制带 `origin/sample_size/coverage/spread_origin/confidence`。
五陷阱处理：① 招式取真实队伍**实际 4 招组合众数**（非 usage 边际拼凑）；② 按 道具+特性 聚类分裂(上限3)；
③ SP 优先取**真实队伍共现谱**众数标 `spread_origin=real-team`（来源已有：yakkun 单打详情页含真实 SP 谱）；
源不含谱时（如 Limitless 双打 decklist）才退回 meta spreads 众数标 `usage`（⚠️ 混合来源）。
（M4 对手 set resolver 已落地此分流：`repset` 出真实共现谱、`sources._merge_set` 真实谱不封顶 / meta 谱封顶 medium / 无谱 low。）④ 小样本退回 usage + 降置信；
⑤ ⚠️ 双打角色依赖搭档，单一 set 可能模糊。混合构造不是真实 set → 推迟 + cell low 置信 + 用户侧实算。

> **M5 step 1（2026-06-25 落地）**：①③④全部落地于 `repset.py`，**②聚类分裂已补**——
> `representative_sets_from_teams` 按 `(item,ability)` 分簇、按簇规模排序、上限 3，每簇出簇内众数联合 set +
> 簇内共现谱，带 `cluster/coverage/share/species_sample/confidence`；无单簇达样本线但物种整体过线时，回退单条
> 全局众数并标 `fragmented`（诚实降级，非伪造）。CLI 入口 `team.py repset <species> --game-format single|double`
> （事实多视图、不评分、不排"最优"，按真实出现率列）。注意 `resolve_opponent_set` 仍取**单条全局众数**作对手
> canonical set（聚类查询是**附加**视图，不改 resolver 行为）。
> **step 2 缓存层亦已落地（2026-06-25）**：见 §9 末——`oppcache.py` + `dev/update/team/cache.py` + CLI `oppmatrix`，
> meta top-K 标准 set 两两矩阵、随环境重建、cell 一律 low 置信 `vs-standard-set`；**攻方行仅给真实队backed物种**
> （字面实现 §15 Q5 的"仅为过 MIN_SAMPLE 物种建 cell"——meta-only 无真实联合招集、只作守方，不犯陷阱①）。

---

## 11. 迭代循环协议

```
意图 → build-context(AI 翻译) → 选核心(AI) → propose 部分队伍 → validate(L1) → diagnose(L1)
     → 结构化缺口 → fill 多视图候选(L3) → AI 选 → 队伍长大 → 完整后 selection/meta-pressure(L2)
     → benchmark 调配 → 收敛
```
每步无状态、客观、带 evidence/置信度；AI 创造与权衡，但不把多视图合并成单一推荐。

---

## 12. 外部系统 / 前端互操作（skill 边界止于 json I/O）

前端是**独立项目**，skill 内不设计它。对接靠**干净的标准 json 契约 + AI 充当 bridge**：

- **输入方向**：AI 从用户给的前端 endpoint（如 `http://host:port/...`）取数据（owned 宝可梦、当前队伍）→
  翻译成 `build-context`/`team-json` → 喂 skill。
- **输出方向**：skill 的 json 产出（team-json、诊断、候选、对面矩阵）→ AI POST 回前端 endpoint，或前端来拉。
- skill **不知道前端存在**；只要 I/O 是干净标准 json（`--format json` 已具备），任何前端都能接。

> 例："我的前端在 host:port，按我现有宝可梦帮我推荐/评估队伍" → AI 从 endpoint 拉 owned/队伍 →
> `build-context(owned_only)` + `team-json` → skill 诊断/候选 → AI 把结果回写前端。

**分层与边界（关键）**：
- **skill = 事实层**：出诊断事实 + evidence + 多视图，**不出综合强度分**（§0 不变）。
- **前端 = 展示层**：可把 skill 的事实组织成任意展示，**包括前端自己定义的"评分"视图**——但那是前端用 skill
  事实自行合成的呈现，**不是 skill 产出的强度分**。"为我评分"由前端/AI 在事实之上组织，skill 仍只给事实。
- **AI = bridge + 组织者**：搬运数据、翻译 context、组织呈现。

这样 skill 的能力边界干净（只认 json），前端可独立演进，且不破坏"skill 不出强度分"。

---

## 13. 路线（M1–M5，风险递增）

> **决策（设计审计后定）：地基优先**。先做 Foundation（可执行契约、三态合法性、集中规则常量、completeness、自动镜像、真实 dex/NCP/calc 合约测试），
> 再把 selection 列为 M2 核心，tune 走「只吃显式 benchmark、SP+性格联合、不自动拼 canonical set」。M1/M2/M2.5 现已全部落地（开发现状见 `dev/team_skill_dev.md`）。

- **M1**：可靠输入输出 + 硬校验。team-json/`build-context`/completeness、`validate`（含道具池）、owned。
- **M2**：无缓存诊断（可解释）。defense/offense（可靠性分级）/speed（上下文）/roles，全带 evidence+置信度+reason。
  - **M2.5**：`tune` —— SP 微调 = 悬崖探测（§16）。生存 + join 速度 + 击杀 + 余量 + nature 车道，威胁走 `build-context.benchmarks` 显式目标。
- **M3**：候选检索。多排序视图 + replace-impact diff，**禁止综合评分**。
- **M4**：真实队伍库，**先只 templates/query，不参与诊断与排序**（留 team skill 内，不拆）。
- **M5**：样本稳定后再做代表 set + 缓存（随环境重建，cell low 置信）。
- 前端：独立项目（§12），不在本设计。

---

## 14. v3 变更摘要（相对 v2）
- §0 加**工作边界**：只服务当前环境、不做数据过期工作、不跨规则推荐。
- §8 **道具池=dex.items**（修正 v2 的"rules source 管道具池"；不建外部清单）；validate 已加道具池校验。
- §9 缓存时效**大幅简化**：随环境重建、query 假定当前、`built_for` 一项，**删五维版本戳**（被产品边界推翻的过度设计）。
- §4 real-teams **不拆独立 skill**（产品决策已定）；历史留档、可显式参考、默认只当前。
- 新增 §12 **外部系统/前端互操作**：skill 止于 json I/O，AI 作 bridge，前端独立；"评分"归前端展示层、skill 仍不出强度分。

## 15. 给审计者的开放问题（更新）
1. 规则常量当前硬编码在 validator；何时值得抽成 `(season,rule)` 常量模块（取决于规则变更频率）？
2. `extracted_set`（单打博客 LLM 抽取）的可信度如何量化进 evidence？
3. 多排序视图如何防 AI 端再合并成单一推荐——SKILL.md 措辞 vs 结构约束？
4. 前端互操作的 json 契约是否需要一个稳定版本号 + 最小字段集规范（便于前端独立演进）？
5. ~~M5 触发"样本足够"的客观判据（队数阈值/覆盖率）？~~ **已定（固化于 `repset.py`）**：
   判据是**逐物种/逐 archetype**（非全格式单一开关）——双打库逐物种密度远高于单打库（≥10 occurrence 的物种数差异
   巨大），全局"格式是否就绪"开关要么饿死单打、要么信噪声。故每个代表 set
   仅在**自身样本 ≥ `MIN_SAMPLE`(3)** 时产出，置信度由**样本量 ∧ 众数占比**共同折叠（薄/碎的物种读 `low`、绝不冒充扎实）。
   step 2 缓存层同用此线：仅为过 `MIN_SAMPLE` 的物种建 cell，且 cell 一律 `low`（reason=`vs-standard-set`）。

---

## 16. SP 微调算子（tune/benchmark）—— 规格（2026-06-20 设计定稿）

> 人类建队的核心环节之一是**微调努力值（Champions = SP，1 点 = +1 属性，单项≤32、总和≤66）**：少量加减
> 改变对位（差一点吃不下→刚好吃下反杀；刚好超某速度线）。usage 数据里 SP 多呈极端/双峰分布——低端局掩盖 +
> 微调无法聚合成高百分比——所以**照抄 usage spread 是陷阱**；确定性的阈值反算才是正路。本算子是它的家。

### 16.1 本质：悬崖探测，不是空间优化

对战是混沌系统（伤害随机数 × 数十只 meta × SR 有无 × 攻守变化 × 天气/特性/道具…），遍历谱空间无边无际。
人类不搜索空间，而是**站在当前谱上，看身边有没有"差一点点就翻面"的悬崖**。算子据此设计为
**cliff-proximity detection**：固定当前谱，向各维度探测最近的离散悬崖，只报小 ΔSP 能跨过的。

**三剪枝 + 一窗口**把无穷压成有界：①威胁表 = meta usage top-K；②每威胁 = 一套 canonical set；
③条件 = 极小精选集（由 §16.4 context_profile 的占比门控）；④nudge 窗口 = 只反解到悬崖、只报 ΔSP 小者（不全扫描）。

> ⚠️ **2026-06-21 修正(消除与 §10 的内部矛盾)**：②的 canonical set **不能简单把招式/道具/性格的独立众数拼起来**
> ——那正是 §10 陷阱①禁止的"usage 边际拼凑",会造出现实不存在的组合。当前 `metalink.py` 落地的是**受限近似**:
> spread 取 meta 面板的**真实联合行**(每行一套 H/A/B/C/D/S + 占比),特性近乎确定,但 item/nature 仍是边际——故**强制带占比+置信度+
> 边际告诫**,且**仅用于"已显式点名的威胁"的攻击 set**。①的**自动威胁列表**(meta top-K)与真正的联合 canonical set 依赖
> M4 真实队伍 / M5 representative-set,**在此之前不做**。

### 16.2 悬崖分类（只报跨过离散悬崖者）

- **生存悬崖**：吃满伤 / 吃 SR 后满伤 从"死"→"活"所需最小 HP/Def/SpD SP。**概率感知**：报"保证存活=扛满伤"、
  "约 N% 存活"等离散概率点（对应"大概率吃下"），不是非黑即白。需 ncp 算伤害。
- **速度悬崖**：闭式公式（`floor((floor((base*2+31)*0.5)+5+sp)*natureMod)`，纯算、不调 ncp）。**必须 join 伤害**——
  只报"赢/输这条速度线会改变实际交换结果"者；超速但打不死、对位不明朗的**沉底或不出**。
- **击杀悬崖**：对常见目标 3HKO→2HKO / 2HKO→OHKO 所需最小攻击 SP。
- **余量悬崖（反向）**：当前扛满伤还剩大量余量 = 过投 → 提示可抽出 SP（"省一点点不亏"，同属边界）。

### 16.3 优先级 = 涌现排序 + 两个"只分配探测力气"的先验

> 关键约束：**优先级不是给宝可梦贴角色标签**（那是主观、易错、且越界成强度判断）。它是悬崖卡的**客观排序** +
> 两个只影响"探测预算/默认顺序、绝不删事实"的先验。角色适配性是**结果**，不是输入。

四个客观排序信号（一句话统摄：**一道悬崖的价值 = 它翻转的下游 OUTCOME 的 幅度 × 常见度 × 决定性 × 便宜度**）：
1. **便宜度 Δ**（跨过要几 SP，越少越高）；2. **对手常见度**（usage 占比）；3. **结果幅度**（2HKO↔3HKO 巨变；
97%↔95% 本就活得宽≈0）；4. **决定性/耦合**（跨过去是否真翻转有意义交互；速度必与伤害联算）。

两个先验：
- **A. per-format aspect_priority**（context_profile，人类经验种子）：双打 `{进攻:高, 速度:高, 防御:低}`；
  单打 `{进攻:中高, 防御:中高, 速度:中}`。只调排序权重，不抹事实，可后续 meta 刷新。
- **B. per-mon aspect headroom**（种族值客观派生，**非角色标签**）：给定基础种族值 + SP 预算，预估各维度有无悬崖潜力。
  低 HP/防/特防（如 Mega 雷丘）→ 防御 headroom≈0 → **跳过深探防御**（仍跑一遍浅探以捞"特别常见对位 + 加一点点能吃"
  的稀有例外）；高防/特防的受向宝可梦 → 防御 headroom 高 → 深探（2HKO/3HKO 边界富集）。

**与"强度分"的区别**：强度分给队伍/宝可梦排好坏（禁止）；这里给**某只该探哪个维度**排检索效率，永不评价其强弱。

### 16.4 context_profile（per-format 环境画像）

把 SR / 顺风 / 空间 / 天气 / 屏障 统一成**带 meta 占比权重的条件**，外加 §16.3 的 aspect_priority。
**先用人类经验硬编码种子默认起步**（已定），后续用 meta（统计对应 setter/招式占比）刷新；meta 薄时退回种子。
- 单打种子：顺风≈0（默认不在顺风语境算速度）、空间低、天气削弱、**SR 次级**（占比偏低但非 0）；进攻≈防御。
- 双打种子：顺风高（速度悬崖**优先在顺风语境**算）、空间在、天气常见、**SR≈0**（默认不算）；进攻 > 防御。
- 条件按占比决定 **纳入主悬崖 / 次级注记 / 忽略**。低占比条件（如单打 SR）只在"正好翻面"时追加**带占比的低优先注记**，
  不进主列表（类比"环境几乎不配清钉手——罕见但非无用"）。

### 16.5 速度：覆盖率而非单点（破"你4我8他12最后人人252"）

速度是你追我赶的军备竞赛，**单点"+N 超 X"是错误形态**（目标在动）。改为：
①**分布 + 覆盖率**：报"压过 ~X% 的某只；到 Y% 需再 +N 速"，让递增成本（arms race 代价）显式可见；
②**锚定自然刻度**（满速基础X / 加速性格基础Y / 0 投基础Z）；③**呈现两个稳定均衡**（全速入场 / 躺平堆耐久靠先制·速度控制·换人绕开），而非怂恿不稳定的 +1 creep。

> **实现：`matchup._speed_coverage`**（非 tune——matchup 已逐对手算好场地有效速度，覆盖率是免费聚合）。每成员给 outspeeds N/of + 自然刻度锚 + 清下一簇的最便宜 Spe-SP 跳跃 + 两均衡注记。tune 的 outspeed 仍是**用户显式单目标**悬崖，两者互补。

### 16.6 输出与边界

- 输出 = **悬崖卡片多视图**，按 §16.3 排序，先验调权——**绝不下单一"最优谱"**（隐藏优化器），**绝不替用户挑哪条悬崖重要**（内置 meta 观点）。
- 可选给"满足用户已勾选基准 + 余量按指定优先级倾倒"的**候选谱**（明确、用户指向的优化，非强度判断）。
- 诚实残差（**摊开给人看，不自动求解**）：①悬崖互斥（66 预算下抢点 = 小背包，剪枝后候选少，列出各自成本让人权衡）；
  ②伤害随机数（报概率，不假装确定）；③混沌（异常下降/屏障/双方道具/双打搭档不全建模，锁定声明 baseline + 少数高影响开关，标注"基准非保证"）。
- 入口：意图层 `build-context.benchmarks`（survive/outspeed/ohko/2hko 目标 + 条件），AI 把对话翻译成结构化基准。

### 16.7 路线位（提前，作为下一步重点）

置于 speed/roles **之前/同级**（落在"人类专长强、usage 失效"的缝隙，杠杆最高）。第一版先做**生存悬崖 +
join 伤害的速度悬崖**两类，威胁默认走 `build-context.benchmarks` 显式目标（meta 自动威胁表为后续增量）。
前置数据依赖：context_profile（人类经验种子）、速度=覆盖率、per-mon headroom 预筛。

### 16.8 nature 作为离散车道（SP×nature 收敛设计，2026-06-22 定稿）

**问题**：v1 把 nature 当固定输入，只在固定 nature 下解最小 SP。但 ±10% 性格修正在 SP 量纲里值几十点，
固定 nature 会**误报**——中性性格"无法超速 X"实则换 Jolly 可能 +0 SP 过线；生存同理。联合考量有真实价值，
但把 nature 当自由变量做 nature×SP 联合搜索 = **隐藏优化器**，违 §16.1（悬崖探测非空间优化）/§16.6（绝不出最优谱）。

**解法：nature 不是被搜索的自由变量，而是一组有界的离散车道（lane）。** 每条车道 = "换一个 nature 后跑一遍
现有的 1-D SP 求解"（生存走 ncp `solve_min_sp`、超速走闭式 `solve_outspeed`/`champ_speed`）——**无新搜索维度**，
复杂度 = 悬崖数 × 车道数（≤当前+~3），线性。每条车道把**机会成本**摊开，由用户（模型）选车道，**无车道自动夺冠**。

**候选车道生成**（目标属性 T：生存→Def/SpD，超速→Spe，未来击杀→Atk/SpA）：
`{ 当前 nature } ∪ { 对 T 的修正 **严格大于当前** 的性格中通过下列现实过滤的子集 }`。
"对 T 的修正"∈{+10%, 0, -10%}，候选必须比当前更有利于 T，这覆盖两类：
- **+T 性格**（标准表恰 4 个，惩罚 -10% 各落其余 4 属性，HP 永不参与）——把 T 直接拉高。
- **去负车道（关键，勿漏）**：当前性格若恰好**降低 T**（如 Hasty=+Spe/-Def 面对 Def 悬崖），最省的改动往往不是
  换 +Def，而是**去掉对 T 的负修正、保留原加成**——换到"同样 +当前加成、但惩罚移出 T"的中性-T 性格
  （Hasty→Jolly：仍 +Spe，把惩罚从 Def 挪到未用的 SpA）。只取 +T 性格会漏掉它、误报 unreachable 或只给更贵的方案。

**现实门（首要、2026-06-24 收敛）+ 两条 per-build 过滤**：

0. **meta 出现率现实门（PRIMARY）**：候选性格**必须是该种在 meta 实际跑过的（出现率 ≥~2%，`metalink.nature_distribution`）**，
   否则**根本不进候选**。这取代了原先合成的"减防慎用"启发式——抽象性格表里绝大多数性格（纯物攻手身上的减防/换速性格等）
   现实中没人用，凭空提议就是噪音。用真实 usage 兜底比任何手写"哪些罕见"规则都干净。**meta 无数据/未上榜 → 不提议任何车道**
   （无法用现实背书）。实测：Garchomp meta 性格 ={Adamant,Impish,Jolly} → 减防性格全被门掉、零噪音；Incineroar
   ={Adamant,Brave,Careful,Impish,Jolly,Relaxed,Sassy} → 多面手才拿到真实的 Careful/Impish 车道。
1. **in-use 过滤（per THIS build）**：在 meta-real 候选中，惩罚属性若①本成员投了 SP、或②是其种族值进攻属性
   （复用 roles `_stat_orientation`：物理→Atk/特殊→SpA/混合→两者）→ 降为 **summarize**（注记存在、不主推）。
2. **减速度锁死（承重，不可乱改）**：当前性格若是 -Spe（Brave/Relaxed/Quiet/Sassy），几乎一定是**空间/天气体系
   的刻意慢速** → **永不自动提议任何改 Speed 的车道**（标 `locked`）。
   > ⚠️ **但用户显式 benchmark 优先**：若用户**显式**提了该成员的 outspeed 基准，仍**照常在当前性格上计算**
   > （显式请求必算、不能静默 `skip`），只是**不提议换 Speed 性格的车道** + 注记"该成员 -Speed，疑似空间/天气体系"。

**重要性门控**（防 nature-creep 噪音，与"只报小 ΔSP 悬崖"同源）：一条 nature-alt 仅当**实质改变结果**才浮现——
①把当前性格下 `unreachable`/`infeasible` 的悬崖变可达，或 ②省出 ≥~8 SP（阈值可调）可重新部署；否则丢弃。

**呈现（不当优化器的工程红线）**：
- 主排名卡片列表**完全不变**——仍是当前/带来的 nature 上的 SP-only 悬崖（向后兼容）。
- nature 车道作为该悬崖卡的 `nature_alternatives` 子字段附挂，**绝不进 `score_card` 头部排名**（否则 ΔSP=0 的
  Jolly 车道会因便宜度飙到第 1，读成"工具建议换 Jolly"）。
- 唯一例外：当前性格下 `unreachable`/`infeasible` 而某车道能解锁时，卡上显著标 `nature_unlock`（事实，非推荐）。

**纪律红线**：❌ 不做 nature×6维SP 联合搜索；❌ 不出推荐谱/单一 (nature,SP)；❌ nature 切换永不进头部排名、
永不显示为"该这么做"；✅ 永远摊开机会成本 + 注记"性格是整谱级单槽承诺，工具只暴露杠杆、由人定夺"。

**边界与交互**：HP 无性格 → 生存的 HP 路径与 nature 无关（注记、不生成车道）；混合防御需求按悬崖分别给、不聚合；
66 总预算每车道重算（一条车道把 infeasible 变 feasible 即头条）；**复用现有成员级 `locked`**（schema.md §7，无单独
`lock_nature` 字段）——`locked` 成员不提议任何 nature 车道（用户声明该成员不变）；
completeness 低（真实 nature 未知）→ 沿用置信封顶 + 额外标注"提议更换更具推测性"；车道内数学精确 → 不因换性格压置信
（applicability 是用户判断，不是计算不确定性）。

**数据依赖（enabler）**：扩 `metalink` 暴露 nature 分布（现仅返回 modal nature）；复用 roles `_stat_orientation` 判进攻属性。

**触发**：自动（默认对每道悬崖算车道）+ 重要性门控 + 尊重 locked；无需用户额外输入。

**落地（已全部实现）**：`cliffs.candidate_natures(T, member, meta)` 纯函数（有界生成：对 T 修正 > 当前 + 去负车道 + 三过滤）；
`_survive_card`/`_outspeed_card` 的"给定 nature 解悬崖"内核 + 车道循环 + 重要性门控 + 附挂；`metalink` nature 分布导出 + `team.py cmd_tune`
传 `context.locked`（locked 成员、-Spe 成员不自动提议车道，但显式 benchmark 照算）；md/json 呈现 + 红线注记。hermetic 测试覆盖：
解锁、去负车道（Hasty→Jolly 解 Def 悬崖）、机会成本、in-use 过滤、减速度锁死（自动抑制但显式基准仍算）、meta 校准、locked 跳过、HP 无车道。

---

## 17. 项目级待办（非 skill 设计：i18n / 发布分发）

> ⚠️ **范围说明**：本节不是团队 skill 的架构设计，是**项目级**的开放工作项，2026-06-25 统一汇总到此（i18n 评估结论 + 原 `dev/release/TODO.md` 迁入）。与 §1–§16 的设计纪律无关，纯路线/待办。

### 17.1 日文（多语言）支持 —— i18n 框架方案（评估结论 2026-06-25）

**现状（已核实）**：
- **名字数据层基本三语就绪**：meta `details_<season>_<fmt>.json` 已带 `pokemon_ja` / 招式 `name_ja`；dex 的 ja **仅作输入 alias**（`aliases` 表 ja→canonical，无正向输出字段），但构建期种子 `dev/update/dex/seed/ja_aliases_seed.json` 是**正向 `canonical→[ja]`**，可落成出货库的 `display_name_ja`。
- **UI/模板零 i18n**：team 诊断 md 全英文硬编码（散落 `diagnose/matchup/fill/selection/tune` 的 `format_*_md()`）；meta xlsx 全简中硬编码（`meta_query.py` 列头 `排名/中文名/招式…`、`FMT_SHEET=单打/双打`、字体 `汉仪旗黑`）。无 `--lang`、无翻译表、无语言枚举。

**关键洞察（决定范围）**：这是 AI agent，字符串分两类、本地化必要性天差地别——**事实名**（Pokemon/招式/道具/特性）**必须 skill 级 i18n**（铁律 §0/§1 禁 AI 凭记忆答战斗事实，名字不能让 AI 猜译）；**UI 散文标签**（"Weakness concentration" 等）**Claude 能安全本地化**，无战斗后果。⇒ 框架"**事实优先，UI catalog 可选**"。唯一 AI 兜不住、且为静态产物的 UI 是 **xlsx**（不在 AI 回路里）。

**框架形态**：stdlib-only **JSON catalog + `t(key, lang)` 助手 + 统一 `--lang {en,zh,ja}` / `CHAMP_LANG` 默认**。**不上 gettext**（`.po/.mo` 工具链是外部依赖，违背项目 stdlib-only 取向）。两个硬约束：①**双镜像**——catalog 进 skill 树、随 `update.py mirror` 同步、过 `test_mirror_parity`；②**skill 相互独立**（各自可独立安装发布）——i18n 助手 + catalog **只能每 skill 自带一份**（~30 行复制，无法共享 import）。

**分期 TODO**：
- [ ] **P0 基建（~1d）**：catalog loader + `t()` + `--lang`/`CHAMP_LANG` + 语言枚举 + 每 skill 自带 + mirror/parity 接入。
- [ ] **P1 事实名链路（~1–2d，核心）**：meta 查询接 `--lang`（字段现成，低）；dex 构建期把 seed 正向 ja 落成 `display_name_ja` + champdex `--lang`。**唯一硬障碍 = dex seed 对 pokemon/moves/items/abilities 的覆盖度**（abilities 已覆盖，其余未验）。**开工前先只读验证覆盖度**。
- [ ] **P2 xlsx 日文（~0.5–1d）**：加「日本語名」列（meta `pokemon_ja` 现成）+ panel 取 `name_ja` + ~15 个表头/sheet catalog + **假名字体回退**（`汉仪旗黑` 不一定覆盖假名）。
- [ ] **P3（可选/可缓，~2–3d）**：team UI catalog —— 抽 `diagnose/matchup/fill/selection/tune` 硬编码英文标签进 catalog。性价比低（AI 可兜底散文），按需再做。

**建议**：先做 **P0+P1+P2（~3–4d）**——立起可扩展框架 + 覆盖"必做的事实名 + 静态 xlsx"；P3 留可选。比分期补丁多约 1 天基建，换来加第 3/4 语言近免费 + 不为 AI 本能做的散文翻译买单。

### 17.2 发布 / 分发（2026-06-25 从 `dev/release/TODO.md` 迁入）

- [ ] **国内镜像 (Gitee)**：镜像 `pmwl0128/pokemon_champion_agent` 到 Gitee，CN 用户走快路（`npx skills add <gitee-url>` 与 `git clone` 都吃）。上线后在 README 安装节加 🇨🇳 注记。**最轻的 CN 收益、无需服务器。**
- [ ] **阿里云一键装 + 域名**：`curl -fsSL https://<domain>/install.sh | bash` 从用户阿里云机器拉 tarball + 落地页。**BLOCKED**：服务器地域（大陆 vs 港/海外）、大陆需 **ICP 备案**、HTTPS 证书。锦上添花，非核心。
- [ ] **提官方 `anthropics/claude-plugins-official` PR**：上架后用户可 `/plugin install pokemon-champions@claude-plugins-official`（分发放大器；有质量门槛）。
- [ ] **Claude 插件 install 冒烟测试**：真跑 `/plugin marketplace add pmwl0128/pokemon_champion_agent` → `/plugin install pokemon-champions@pmwl`，确认 3 skill 加载（结构已按文档搭，未端到端跑过）。
