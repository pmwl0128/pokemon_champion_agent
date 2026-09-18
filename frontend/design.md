# Pokemon Champions Web - 设计摘要

本文只记录 Web 跨前后端的长期设计边界。字段、命令、部署步骤、性能数字和变更过程分别以协议 schema、代码、`dev/**/README.md`、benchmark receipt 与 Git 历史为准。章节编号保留为稳定引用锚点。

## §1 目标与非目标

Web 共用一份 SPA，提供两种运行时：

- **在线版**：公开浏览和浏览器计算；受限事实问答、简化建队与可选诊断解读由在线服务完成。
- **本地版**：`pcui serve` 调用本机四个 skill，并提供 UEP 会话、artifact 和精确调校。

运行时差异只来自 capabilities、部署配置和 adapter。Web 不改变 skill 的 canonical JSON；在线版不提供自由连续对话或用户历史。本地网页不负责唤醒或遥控 agent。

## §2 总体架构与 Build-once 不变量

```text
                        shared SPA / Web DTO
                      ┌──────────┴──────────┐
               OnlineAdapter          LocalAdapter
                      │                     │
            static projection +       pcui local bridge
            browser calc worker       skill workers + SQLite
                      │                     │
             restricted online API    pcui CLI / optional MCP
```

同一提交只构建一次 Vite `dist`，在线部署与本地 wheel 使用同一产物。`dist` 不包含 `runtime-config.json` 或 projection；运行时先读配置和 capabilities，再选择 adapter 与按需 chunk。

组件只依赖 domain hook/repository 和 `RuntimeAdapter`，不得判断 runtime 或直接访问传输层。缺少 capability 就隐藏或降级入口，adapter 不提供伪成功 stub。projection 与 live API 经同一 mapper 进入同一 DTO；所有外部数据都在边界通过 Zod，解析失败视为版本/部署错误。

### §2.1 语言规范

- UI 文案按用户选择的 zh/en/ja 显示；切换语言不改存储数据。
- 实体 join key 始终是 dex 英文 canonical；显示层本地化，英文回退。
- LLM 使用界面语言 prose，但实体仍输出英文 canonical，再由 renderer 本地化。
- 实体之外不得出现内部标识符：DTO 字段名、role key、JSON 路径和枚举值都不是界面语言的词。做法是双向兜底——投影只喂模型页面同款公开用语（role 标签按界面语言本地化、不带 key），生成后再确定性改写残留标识符；提示词约束不单独作数。C2／C1／C0 是页面自身印出的等级码，属公开词汇。
- 自由输入可混用三种语言，名称归一只发生在 dex/parse 边界。
- 不能解析英文错误消息来推导领域状态。

### §2.2 视觉与动效规范

在线与本地运行时共享视觉 token 和组件语言。属性色只表达属性、倍率和等级等数据语义。动效只提示层级与状态，避免布局动画和持续动画；`prefers-reduced-motion` 必须关闭非必要动画。焦点、选中和错误不能只靠颜色或动画表达。

## §3 协议层（`frontend/protocol`）

协议包 Zod-first：schema 是运行时权威，TypeScript 类型由 `z.infer` 派生。React 不直接消费 raw skill JSON、投影内部文件或 provider 响应。

capabilities 只负责发现功能，不负责授权；每个端点仍独立校验身份、命令、参数、体积、超时与并发。版本身份分工：

- `webProtocolVersion`：API 兼容性；
- `uiBuildId`：SPA 构建身份；
- `skillFingerprints`：实际 skill 代码和数据；
- `deploymentId`：完整发布装配；
- `calcEngineDigest`：浏览器计算引擎快照。

raw skill 只在 bridge mapper 转换；projection 构建复用同一 mapper。JSON Schema catalog 从 Zod 单源生成并做精确再生成检查。local/online bridge 都提供 `/api/openapi.json`；显式路由目录必须覆盖全部公开 `/api` 路由，所有 `$ref` 可解析，release 不依赖源码路径。

## §4 本地 bridge（`pcui serve`）

### 4.1 进程模型

FastAPI 使用单主进程。dex、meta、calc 和 speedline 走通用 NDJSON worker；worker 失败可回退一次性子进程，结果必须等价。team 请求通过 `team.py session` 批处理，使批内 sibling 复用；不得把私有 dispatch 当长期接口。

用户配置统一位于 `~/.pokemon-champions/pc.env`。端口、provider、密钥和主机路径不写入仓库，也不按运行目标拆成多个 env 文件；本地进程只读取自身需要的项。API 只接受白名单操作和受控参数；文件内容由客户端内联，daemon 不接收任意路径或 argv。

### 4.2 会话与 artifact

SQLite 是会话事实源。artifact 按 `kind + canonical payload` 内容寻址、不可变并可复用；ledger 只追加，session head/revision 在同一事务中 CAS。原始 artifact 文本逐字节保存，用于 receipt、frame 和 slate 重放。

目录导入导出只是兼容层。daemon 存活但不可达时，CLI 禁止直写 SQLite，以免 split-brain；只有确认 daemon 未运行时才能离线访问。

### 4.3 本地安全边界

bridge 默认只监听 loopback。浏览器用 URL fragment 中的一次性 bootstrap token 换取 HttpOnly、SameSite=Strict cookie；CLI 使用用户私有 daemon secret。服务端校验 Host、Origin、体积和时限，并拒绝任意路径、命令与跨域调用。

开放 LAN 必须显式指定 host 并确认风险；这不是多用户安全部署。

## §5 agent 集成

`pcui` CLI 是本地协作的权威入口，提供 session/artifact 操作、白名单算子、环境诊断和 companion skill 安装。companion 只说明如何按 UEP 读写工件，必须显式安装，不能由 Web 或 pipx 偷偷注入 agent。

MCP 若启用，只是同一 API 的薄适配，不形成第二套会话协议。artifact append 必须提交 revision 并原样返回 CAS 冲突；适配层不得自动合并。首选本地 stdio，远程传输不与首版同时引入。

## §6 本地 UEP 会话面板

会话面板是 UEP 工件的只读透镜和 checkpoint 输入面：

| 环节 | 页面职责 |
|---|---|
| audit / frame / slate / answer-audit | 渲染 agent 写入的事实、候选和审计结果 |
| checkpoint | 以当前 revision 写 decision；冲突后重读并重新确认 |
| validate / diagnose / matchup / select / tune | 直接运行确定性工具 |

面板不重写或强校验 agent artifact；已知形状尽力摘要，不匹配则显示原文。SSE 只通知，事实仍从 SQLite/session API 重读。本地页面位于 capability 门控的动态 chunk，在线端不得请求。

快速计算是无会话工具；复杂调校和自然语言目标写入会话，由 agent 转成 benchmarks。agent-authored artifact 必须按不可信输入处理，renderer 宽容解析但不能执行内容。

新建会话只收自然语言意图，不另设赛制字段；单打、双打和其他约束由 agent 从同一段意图中归一。创建动作与输入位于同一卡片内，会话列表不承担 intake 表单职责。

## §7 在线版

### 7.1 静态投影与浏览器计算

projection 是公开裁剪 DTO，不是 skill 数据镜像。它可以包含 dex/meta 展示、趋势、图片 manifest、加工配置和 opponent matchup 参考；不得含 raw real-team JSONL、build-state、quarantine、PII 或可还原整队的数据。公开 sets 剥除 provenance，页面不得暗示其来源或强度。

projection、bridge、skills 与 SPA 共享 `deploymentId`；内容 URL 带发布身份，manifest/capabilities 不一致时拒绝混用。不得直接暴露 `.agents/skills`。

发布期不变事实使用会话级 single-flight 缓存，键包含 deployment、数据种类、format 和实体；成功项做有限 LRU，失败项可重试，旧请求不得覆盖新依赖键的可见状态。

伤害、速度和耐久快速试算使用与 ncp 同源的 vendored JavaScript，并在 Web Worker 中懒加载：

- OnlineAdapter 的 damage/damageBatch/speedBatch 在客户端完成，组件不区分宿主；
- opponent cache 是去来源的标准配置参考，不替代用户队 live matchup；meta-only 目标不伪造攻击档位；
- 计算器自动配置与模拟表头共用轻量 `oppsets` 视图，不为单只配置加载伤害矩阵。自动填充取真实队伍
  聚合中占比最高的完整配置；聚合为空才回退到各字段边际众数组成的 Meta 配置。手动选择始终把该
  Meta 回填列在真实配置之后。配置选择卡直接展示完整的道具、特性、性格、招式与 SP；悬浮信息只
  用于确认已经选中的配置。批量计算结果携带本次输入的只读显示快照，结果过期后不得拿当前编辑值
  冒充计算时配置；
- 跨规则交接只影响 team 派生的参考配置和网格。DTO 携带 `teamEvidenceExpiresAt`，并在同一 deployment
  提供 native 视图；浏览器到期后原位切换，原生样本不足则显示无参考矩阵。dex、meta 和计算引擎始终
  使用当前规则，不能随 team 证据延长；
- `team.tune` 是受限确定性 API，浏览器反解不能标作精确 tune；两者必须描述同一帧，浏览器侧的调校请求与 `tune` 算子一样关闭出场降能力（`switch_in_drops:false`），否则同一组输入会给出两个答案；
- SPA 与 projection 的 `calcEngineDigest` 不一致时拒绝计算。
- 计算器的 pokepaste 导入在**浏览器内**解析，不走 §7.5 的服务端队伍文本解析：那条链路是配额后的在线能力，而计算器必须在在线运行时纯客户端可用。它只认 Showdown 导出块，名称原样交给 dex 归一（dex 是唯一命名权威）；本篇努力值按同等投资折算到 66 点 SP 预算并在界面上声明折算，不静默改写用户配置。

公式权威和 vendor 边界见 [`../dev/design.md`](../dev/design.md)；Web 只做宿主适配。

### 7.1.1 环境详情页的两条数据轴与页边栏

meta 详情页承载两条独立数据轴。usage 轴（ranking/details）与 KO 轴（`ko_*`）来自同一主源但走不同快照时钟，
因此 KO 是独立 DTO 与独立投影文件族，在页面底部自带 `updatedAt` 与快照号，不并入 detail 的面板网格，
也不共用页面的单一环境戳。

- KO 对象只有顺序、没有占比（来源不发布），DTO 因此**不含** percentage 字段——留 nullable 会被读成实测 0。
- KO 招式占比是保留层：未采集时为 `null` 而非 `[]`，`coverage.moveShare` 同步声明；渲染必须占位说明，
  消失会被读成"没有击倒招式"。
- KO 对象身份只到种族级（全国图鉴编号），同一编号在一条列表里重复时两条都保留并标记，不去重。
  打印出来的名字保持种族级，但 `slug`/`key` 必须指向**一个真实形态**——sprite 和链接没法指向一个种族。
  能被 dex 精确命名的种族就是它自己，否则用 dex 给那个光秃秃种族名指定的代表形态；使用率名次跟着同一个
  形态取，于是"画的是谁、算的是谁、点过去是谁"是同一句话。
- 方向不用绿/红：对位网格已占用 KO 分档与 check 等级色带，暖/绿在此会被读成评价。方向用 build 标签的
  蓝/紫加箭头字形，灰度与色觉障碍下同样可读。
- 页面展示深度由 mapper 单点裁剪（`KO_PANEL_LIMIT`）。投影是公开裁剪 DTO 而非 skill 数据镜像，
  shipped 数据保留更深的列表，不代表投影要一起变厚。

详情页里所有宝可梦行（队友、两个 KO 栏）都跳**同一 format 的环境详情页**，不是图鉴卡片：读者正在读环境
事实，下一步想要的是同一种页面。种族级行只能跳到那个代表形态——这是"判不出形态就落到第一匹配项"，不是
假装来源给了形态。

每一行都能悬浮出历史小图，数据来自两份懒加载文档：usage 面板与**队友**在 `usage_trend`（details 的时钟），
两个 KO 栏在 `ko_trend`（KO 自己的时钟）。图分两种，因为事实分两种：有占比的面板画占比，只发布顺序的面板
（队友、KO 对象）画**名次**——1 在顶、单位是"位"、向上是变好。把名次画在占比轴上等于凭空造一个没人测过的
量。只有一期时就画那一个点并写明"仅 1 期"：对一条只采集过一次的轴，一个点就是全部真相，画成"数据不足"
会被读成"没有数据"。

左侧页边栏是一层共享外壳，环境、图鉴与计算同用，每处只自己决定宽度与覆盖阈值。环境这一侧栏内是搜索加榜单，
筛选是挂在它右缘的独立浮层，入口是搜索框右侧的小按钮。承重约束是**筛选项与被它改变的结果必须同屏**：
facet 放页面另一侧要"在右边选、到左边看"，塞进栏内下钻则要"点回去才知道选中了什么"，两种都不成立。
浮层允许压住正文，这正是它的作用；勾选实时改左侧列表，浮层保持展开直到按它自己的关闭按钮。

榜单页与详情页挂的是同一条边栏，区别只在筛选的作用域：详情页用它换当前这只，榜单页**只筛栏内列表，
不动外层卡片网格**——外层网格本身就是榜单，从一份排名里静默抽掉几行会把它读成另一份排名。

关闭是分层的、且永不自动发生：浮层的 × 只关浮层，边栏的 × 关边栏并带走浮层，Esc 关最内层。点击榜单条目
只跳转，两个面板都不动——浏览榜单是连续动作。边栏必须渲染在页面的每个分支上（含两只之间的 loading 闪帧），
否则每次跳转都会卸载它并静默丢掉筛选与搜索词。

静息只留把手，展开时由 shell 的内边距吃掉页边留白，`main.content` 的 `min(1240px, 100% - 48px)` 因此先消耗
留白、够宽时主体列不位移；可用列宽低于阈值才退化为覆盖式加遮罩。阈值按内容定而不是一个全局常数：卡片
网格一路重排到很窄仍然可读，多栏面板远在那之前就不成立。

筛选依赖每 format 一份的倒排索引投影文件——逐只 detail 是懒加载的，客户端自行聚合会退化成按 roster 逐个
请求。facet 值是英文 canonical（join key），显示层本地化，语言切换不改变键。

全局排名趋势不占独立顶栏入口，而是环境页面上方的“趋势图”抽屉：从右侧展开，图保持原趋势页尺寸，在抽屉内容区内上下居中，内容超高时可滚动，不改变主页面宽度，也不以排名表替代图。说明文案在桌面端紧跟“排名趋势”标题同排、底部对齐显示；窄屏空间不足时换行，图与顶栏边线保持间距。首屏只渲染把手；抽屉组件、图表代码和趋势 DTO 在首次展开后才加载。窄屏保留图并允许横向滚动。抽屉由应用外壳持有，排名与环境详情之间跳转时保持展开，图上的名称仍链接到同一赛制的环境详情；页面切换单打／双打时，抽屉读取同一个 URL format 并同步切换。

### 7.1.2 图鉴浏览筛选

图鉴四个 tab 的搜索与筛选收在同一条页边栏里，并**随 tab 整套切换**：命中区间对特性列表没有意义，
所以它在那里根本不出现（特性只有搜索，不设筛选块）。每个 tab 各自持有自己的搜索词与筛选条件，
来回切换不清空。

图鉴的宝可梦卡与榜单卡是同一种卡、同一套网格，全国编号占榜单放名次的那个角标位：两页切换时每张卡的
尺寸与位置都不动，视线不用重新找。名字框恒占两行——网格行高取同行最高者，一个折行的形态名会把整行抬高
一行的高度，而单打/双打切换重排的恰好就是长名字的落点。

宝可梦与招式两个 tab 共用同一行属性选择器，但**语义不同且必须写在界面上**，不能让读者靠猜：

- 宝可梦：属性取**交集**。选水+飞行问的是双属性，这是两个选择唯一有用的读法；因此选三个属性必然为空，
  那是关于 roster 的真实回答，空结果照常显示，不得偷偷改判为并集。
- 招式：属性取**并集**。选火+水就是同时看这两科。

取消选择就是再点一次，因此属性行不带清除按钮；两种语义也不在行内印字。

宝可梦另有特性（单选）、招式（多选，取交集＝全部学会）与种族值。边栏有纵向空间，特性与招式因此是
可搜索的勾选列表而不是输入联想：候选摆在眼前才谈得上挑，输入框只能盲打。种族值仍是小型表达式而不是
六组滑块：`spe>=100 bst<550` 精确表达意图、任意组合无需为每种组合做 UI，更重要的是**能报出没看懂的
部分**——已理解的条件照常生效，未解析 token 让输入框转为 invalid 态并在 title 里点名，绝不静默忽略
（同 team `unresolved_conditions` 的纪律）。

招式另有物理/特殊/变化分类与威力、命中、PP、先制四条区间。区间是两个可空数字框而不是滑块：空的一端
表示"不设界"，滑块说不出这句话。先制的格档取自数据里真实出现的值，不铺一行 -7..+5 的固定档位去提供
永远为空的选项。道具按数据自带的自然分类筛，不另造一套分类。

招式筛选依赖 `dex/learners.json` 这份倒排索引：逐只 learnset 是懒加载的，客户端自行聚合"谁会击掌奇袭"
会退化成按 roster 逐个请求。索引只在真的用到招式条件时才取。索引未到达前返回空列表而非未过滤全集——
闪一下错误答案比空列表更糟。

### 7.1.3 计算页配置抽屉

计算页复用图鉴的宝可梦搜索和筛选轴，但结果名称只控制单项展开，不直接改动计算输入。抽屉一次只展开
一只；其真实联合配置与 Meta 回填按需读取，空白自定义项不依赖配置请求成功。各子页独立选择填入方向，
满额时明确拒绝，不覆盖已有配置；耐久调整的单个被调对象则始终替换。抽屉搜索和空白卡片编辑不得触发
伤害或速度批量计算；速度线只在显式计算时汇总我方多只的实际速度。

实际配置对位页复用同一搜索、筛选和联合配置卡，但只有“我方配置”一个填入方向，因此不显示方向开关；
它遵守该页最多十二个待比较配置的上限，切换单打／双打时按新赛制重新读取展开项。速度表中的格子选择
同样是新增动作：先选我方或对方，再把所点速度档加入对应一侧；满额拒绝，不静默覆盖首个配置。

### 7.2 事实问答

在线 QA 是无历史的单次请求。模型只能通过白名单只读工具获取 dex、meta、公开联合聚合和伤害/速度事实；工具和 provider 结果均有结构、轮数、字节、token 与时间上限。未获工具事实时不得把模型记忆表述为项目事实。

在线版把问答、生成向导和可用的队伍诊断收在同一个“AI辅助”页面；问答位于生成向导左侧并作为默认子页。各子页保留自己的 capability 门控和浏览器会话状态，不因切换标签取消在途任务。

provider key 只在服务端。模型、base URL 和额度由部署配置决定。回答使用英文 canonical 实体和界面语言 prose；配置缺省要披露来源与假设。预算先预留、后按真实 usage 结算；用户次数退还与 token 结算是两个独立动作。

### 7.3 简化建队向导

在线向导是一屏输入、一支候选、确定性校验和最终披露，不提供本地 UEP 的候选比较、循环对话或中途 checkpoint：

```text
normalize -> audit/intake -> frame + grounding -> LLM assembly
 -> validate + slate -> direct checkpoint -> draft + answer-audit
```

表单与 profile 默认须覆盖 intake catalog；ID 漂移必须 fail loud。anchor、owned 和 avoid 先经 dex 归一。模型的选材宇宙来自 frame、公开 detail 和明确 Mega options；item/ability/nature/moves/SP 保持联合关系，不能拼接 meta 边际。

模型输出经名称归一和确定性清理后再过 skill gate。tradeoff、偏离、Mega 与对位说明必须引用 slate/audit 事实。guaranteed-OHKO 暴露按 `guaranteed-ohko-impact-v1` 的稳定事实顺序展示完整路线；它只定位本次电池里影响最广的确定 OHKO，不是强度排名。

`web_jobs` 只在任务期间保存重放所需工件和进度；完成、取消或过期后删除。浏览器只保存当前表单和 job id。

### 7.4 限流、预算与隐私

在线服务使用签名设备 cookie 与不可逆短期 IP 身份，不保存原始 IP。QA、builder、diagnose 和确定性接口分别计数与限并发；模型任务和 CPU 任务使用不同 lane。Nginx 与应用层都限制速率、体积、条数和超时。

额度和预算在服务端原子处理，具体数值只在配置和 quota 响应中维护。模型预算只影响 LLM；静态浏览、浏览器计算和已生成的确定性报告不依赖它。正文不进应用日志，短期任务和计数按生命周期清理。验证码只能是附加门，不能替代预算断路器与端点校验。

授权旁路对**所有**计数端点一致生效，管线本身完全不变，真实 token 消耗仍进入总账。服务端仍为每个浏览器签发 HttpOnly 签名设备 cookie；owner dev key 只做恒定时间凭据校验，不绑定设备，因此可在 owner 的多台设备上复用。tester key 在第一次成功请求时绑定该 cookie，服务端只持久化凭据和设备标识的摘要；它可独立创建、轮换、移除并配置 UTC 每日 token 预算，缺省预算为无限，且不获得调试字段。清除站点 cookie、复制已绑定 tester key 到另一设备或复用已轮换 tester key 都不能继续旁路。设备绑定不是硬件证明：首次使用前转发 tester key，或连同完整浏览器资料复制，仍不能由服务端可靠区分；轮换、移除和费用上限负责控制这类残余风险。

🚩 发布 smoke 与浏览器凭据严格分离：`PCUI_SMOKE_KEY` 是不绑定 cookie、不得分发的运维凭据，只用于 deploy observe 和基准工具。浏览器 dev key 不能兼作 smoke，避免把可交互 owner 凭据扩散到自动化环境。新增计数端点必须同时接入 visitor、browser-access 与 smoke 三种路径，不能只接 QA 和 builder。

### 7.5 确定性接口与队伍诊断

capability 负责入口发现，服务端仍独立执行白名单、上限、超时和并发控制。自由文本队伍按 team-json/Showdown、已知分享格式、species-only 三层解析，再统一经 dex canonicalize；不完整结论标为 partial/unknown。

诊断运行 validate、diagnose 和受限 check coverage，再映射为披露安全 DTO。候选直接回流时按最终配置计算，不退化成物种列表；确定性修正改变配置后，解释必须基于修正版重新生成。

`POST /api/team/matchup` 接受结构化队伍或受限文本，返回同一次计算产生的 summary、明细和规范化队伍。Top-K 在 team 合法范围内由消费端指定。公开端按 workload units、队列和确定性 semaphore 公平限额，不消耗模型额度。

`POST /api/team/tune` 只接受无路径 team-json 和有界 benchmarks，通过公开 `session` 算子运行。额度在廉价形状校验后预扣，失败按既定语义退还；返回的 cliff cards 才是精确结果。

roles 的公开值表达注意等级，不是强制模板。AI 解读是确定性报告上的可选单次调用，失败只增加 `explanationError`，不能改变报告事实。

🚩 公网 CDN 会掐断**十秒内没有产生任何字节**的回源连接（源站只看到 nginx 499，浏览器只看到一次网络失败，而服务端往往已经算完）。诊断、实际对位、tune 与 QA 都可能跑十几到几十秒，因此凡是可能超过该窗口的在线端点，都要在 `Accept: application/x-ndjson` 下改用事件流：**第一个字节在开工之前发出**，之后以远小于该窗口的间隔发心跳，最终事件才带结果，HTTP 错误语义以 `error` 事件的 status 透传。首字节不能只靠响应头——中间件会把响应头压到第一个 body chunk 一起发。心跳间隔大于该窗口等于没有心跳。

## §8 部署

在线拓扑为同源静态站与单 worker API：

```text
Nginx
  ├─ SPA dist + projection
  └─ /api -> FastAPI -> restricted LLM / deterministic workers
```

服务使用独立系统用户、venv、systemd unit、SQLite 和私有 env。release 目录只读；随 skill 发布的 dex SQLite 只读，只有主机状态目录可写。

`dist/projection/bridge/skills` 是不可变发布集，`data/env/venv` 是主机状态。发布以完整目录原子切换并保留可验证回滚，不能分别更新前端、投影或 skill。主机、证书、防火墙和密钥属于部署配置。

### §8.1 更新、构建、部署与发布自动化

`dev/update/` 更新数据，`dev/deploy/` 构建并切换不可变 release，`dev/release/` 发布 Git 与 rolling assets。三者共享 commit/manifest 身份，但默认互不触发、分别授权。

长期不变量：

1. 正式输入绑定 clean commit；dirty 仅允许本地预览。
2. 一次构建、一份 SPA；runtime 差异只由配置、capabilities 和 adapter 决定。
3. dist、projection、bridge、skills、calc 与部署配置由 `deploymentId` 和逐文件摘要原子绑定。
4. projection 按对象结构审计，拒绝 raw team、build-state、quarantine、PII 和可还原整队数据。
5. 候选须过本地/online-echo 验收与目标主机 preflight，观察失败只在 live 仍指向该候选时回滚。
6. 不可变内容与主机状态分离；数据库迁移先备份并声明回滚兼容性。
7. deploy、run、dev/public publication 分别写机器 receipt；动态数字只留在 receipt/配置。
8. public 发布从白名单重装配；rolling assets 的省略不能隐式删除其他资产族。

操作以 [`../dev/deploy/README.md`](../dev/deploy/README.md)、[`../dev/release/README.md`](../dev/release/README.md) 和 CLI `--help` 为准。

## §9 成本与容量

费用和容量以 provider usage、benchmark receipt 和主机观测为准，不在设计文档维护单价、请求次数或一次跑数。

- LLM 请求先按场景预留上限，结束后按真实 usage 结算；日预算是总断路器。
- QA、builder、诊断解读和确定性 lane 分别记录成功率、延迟、资源与缓存指标。
- 配置、prompt、工具面或进程模型发生承重变化后重跑固定基准。
- 静态浏览与客户端计算不计模型预算；确定性服务按 CPU、内存和并发独立定容。

### 9.1 确定性通道的定容模型

每个在飞 `team.py session` 是独立进程树，请求间不共享内存；总内存随并发近似线性，CPU 随工作量增长。稳态并发由核数、每请求 RSS 和延迟共同约束，不能只靠增加 semaphore 或内存推高。

具体宽度必须在目标主机上用 capacity benchmark 测量。超过有效核数通常只增加排队和上下文切换；静态内容应尽量卸给 CDN/浏览器，使主机资源留给确定性工作。跨主机 CPU 指数只作粗估，不能替代现场测量。

### 9.2 计算引擎宿主形态

NCP 可由进程内 quickjs-ng、常驻 Node 或 Node one-shot 承载。无 Node 的生产主机上 quickjs-ng 是硬依赖，不是可选加速；preflight 必须单独检查。宿主选择是常驻内存、调用开销和依赖的取舍，批处理会摊薄微基准差异，最终以实际 workload benchmark 决定。

## §10 技术选择

前端使用 React、Vite、TypeScript、ECharts 和 Zod；本地/在线 API 使用 FastAPI、uvicorn 与 SQLite；本地 companion 经 pipx/wheel 分发。版本只在 lock files 固定，升级由类型、契约、构建和浏览器测试判定。

浏览器 worker、provider、bridge worker 和 store 可以替换，但必须保持 §2 的 adapter、DTO、Build-once 和身份绑定。

## §11 仓库与发布边界

`frontend/web`、`frontend/bridge` 与 `frontend/protocol` 在本仓库共同演进；四个 skill 独立发布。Web 发布物包括同一 dist 的本地 UI、dist + projection + online bridge 的在线集，以及绑定发布身份的图片/数据资产。

协议稳定前不拆仓。任何拆分都必须保持 raw skill -> mapper -> Web DTO 单向依赖与跨仓兼容测试。

## §12 图片资产

位图 pack 使用内容寻址文件和 manifest；原创图标、placeholder 与品牌 SVG 随 UI bundle。完整 manifest
是哈希、尺寸与 provenance 的审计权威；projection 从中机械生成只含 key/match/path 的 `runtime.json`，
浏览器 resolver 只读取该紧凑索引，以 dex canonical slug 为主键，不另造图片身份或路径规则。

resolver 返回 `exact`、`base_fallback` 或 `placeholder`。形态页不得把 base fallback 伪装成 exact；无法确认时用占位图。第三方图片记录 provider、URL/revision、获取时间和 rights note；运行时不热链。新增来源或 roster 变化后重建并校验，不得 fuzzy 猜图。发布用 pack 必须与当前 dex canonical Pokémon/item 集合精确相等，每个 payload 的 size/hash 复验通过；projection 构建同时要求当前 rule 的 single/double opponent cache 都存在、非空且源指纹有效。

## §13 开放问题与准入条件

- 验证码只能在预算和端点防护完整后作为超额附加门。
- session store 继续使用整会话 revision CAS；只有 artifact 依赖形成可验证契约后才评估细粒度合并。
- MCP 等稳定 SDK，且必须直接复用 OpenAPI/protocol、鉴权、CAS 和事件语义。
- team 常驻 worker 只有在固定基准证明冷启动是主要瓶颈、skill 先定义正式 `serve` 契约，并完成请求状态、数据代际、池宽与内存审计后才准入；builder 不能以自身长延迟作为理由。
- 队伍/诊断中的计算器 hand-off 必须携带可复算 team、move、conditions 和 evidence；前端只预填，不将摘要升级为精确结论。
- 拆分 Web 仓库须先满足 §11 的单向依赖与跨仓契约门。
