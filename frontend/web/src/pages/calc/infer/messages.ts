/** Copy of the set-inference tool (配置反推), in its own lazy chunk. */
import { defineMessages } from "../../../i18n.ts";

const INFER_MESSAGES = {
  "infer.pair.into": { zh: "{mine} 打 {foe}", en: "{mine} into {foe}", ja: "{mine} → {foe}" },
  "infer.pair.from": { zh: "{foe} 打 {mine}", en: "{foe} into {mine}", ja: "{foe} → {mine}" },
  "infer.pair.intoHint": {
    zh: "按当前推断预测对方掉血（占对方 HP）。选中招式后可在下方记录一次实际伤害。",
    en: "Predicted damage to them (percent of their HP) over the current inference. Select a move to record a real hit below.",
    ja: "現在の推定に基づく相手の被ダメージ予測（相手HP比）。技を選ぶと下で実際のダメージを記録できます。" },
  "infer.pair.fromHint": {
    zh: "按当前推断预测我方掉血（HP）。选中招式后可在下方记录一次实际伤害。",
    en: "Predicted damage to you (HP) over the current inference. Select a move to record a real hit below.",
    ja: "現在の推定に基づく自分の被ダメージ予測（HP）。技を選ぶと下で実際のダメージを記録できます。" },
  "infer.status": { zh: "变化", en: "Status", ja: "変化" },
  "infer.unreadable": { zh: "不可反推", en: "Not readable", ja: "推定不可" },
  "infer.unreadableHint": {
    zh: "此招式的伤害不取决于这里推断的能力值，无法用于反推。",
    en: "This move's damage does not follow from the stat inferred here, so it cannot be used.",
    ja: "この技のダメージはここで推定する能力値に依存しないため、推定に使えません。" },
  "infer.immune": { zh: "无效", en: "No effect", ja: "効果なし" },
  "infer.immuneHint": { zh: "这一击对目标无效，无法用于反推。", en: "This move has no effect on the target, so it cannot be used.",
    ja: "この技は相手に効果がないため、推定に使えません。" },
  "infer.multiHit": { zh: "多段招式暂不支持记录", en: "Multi-hit moves cannot be recorded yet",
    ja: "連続技はまだ記録できません" },
  "infer.koAll": { zh: "必定击倒", en: "Always KOs", ja: "確定で倒す" },
  "infer.koAny": { zh: "可能击倒", en: "May KO", ja: "倒す可能性" },
  "infer.pending": { zh: "计算中…", en: "Computing…", ja: "計算中…" },

  "infer.form.foeHp": { zh: "对方血量", en: "Their HP", ja: "相手のHP" },
  "infer.form.mineHp": { zh: "我方 HP", en: "Your HP", ja: "自分のHP" },
  "infer.form.before": { zh: "之前", en: "Before", ja: "前" },
  "infer.form.after": { zh: "之后", en: "After", ja: "後" },
  "infer.form.crit": { zh: "会心", en: "Crit", ja: "急所" },
  "infer.form.single": { zh: "单目标命中", en: "Hit one target", ja: "単体に命中" },
  "infer.form.singleHint": {
    zh: "双打中范围招式只命中这一只时不减伤；命中多只时按 0.75 计算。",
    en: "In doubles a spread move that hit only this target is not reduced; hitting several applies 0.75.",
    ja: "ダブルで範囲技がこの1体だけに当たった場合は軽減なし。複数に当たると0.75倍。" },
  "infer.form.add": { zh: "加入观测", en: "Add observation", ja: "観測を追加" },
  "infer.form.pick": { zh: "先在上方选中一个可反推的招式", en: "Select a readable move above first",
    ja: "先に上で推定可能な技を選んでください" },
  "infer.form.badFoe": {
    zh: "填 0–100 的整数，之后要小于之前（被击倒填 0）。",
    en: "Whole numbers 0–100; after must be below before (0 = fainted).",
    ja: "0〜100の整数で、後は前より小さく（倒れたら0）。" },
  "infer.form.badMine": {
    zh: "填整数 HP，之前不超过最大 HP，之后要小于之前（被击倒填 0）。",
    en: "Whole HP values; before at most your max HP, after below before (0 = fainted).",
    ja: "整数のHPで、前は最大HP以下、後は前より小さく（倒れたら0）。" },
  "infer.form.addHint": {
    zh: "加入时会一并记下此刻的天气、场地、双方场地状态、能力等级和异常状态（见观测记录）。",
    en: "The current weather, terrain, side conditions, stages and status are recorded with it (see the log).",
    ja: "追加時の天候・フィールド・場の状態・ランク・状態異常も一緒に記録します（観測記録を参照）。" },
  "infer.side.mine": { zh: "我方", en: "Your ", ja: "自分の" },
  "infer.side.foe": { zh: "对方", en: "Their ", ja: "相手の" },
  "infer.foe.adoptedValue": { zh: "采用 {value}", en: "adopted {value}", ja: "採用 {value}" },
  "infer.foe.adopted": { zh: "采用", en: "Adopted", ja: "採用" },
  "infer.foe.natureCap": { zh: "性格（采用）", en: "Nature (adopted)", ja: "性格（採用）" },
  "infer.foe.inferred": { zh: "推断 SP", en: "Inferred SP", ja: "推定SP" },
  "infer.foe.speedNot": { zh: "不推断", en: "Not inferred", ja: "推定対象外" },
  "infer.foe.source.aggregate": { zh: "真实配置 {pct}", en: "Real build {pct}", ja: "実戦の型 {pct}" },
  "infer.foe.source.meta": { zh: "Meta 回填", en: "Meta fill", ja: "Meta補完" },
  "infer.foe.source.custom": { zh: "自定义", en: "Custom", ja: "カスタム" },
  "infer.foe.fit": { zh: "与观测吻合", en: "Fits the observations", ja: "観測と一致" },
  "infer.foe.out": { zh: "与观测矛盾", en: "Contradicts the observations", ja: "観測と矛盾" },
  "infer.foe.note": {
    zh: "推断 SP：按已记录的观测，每项能力仍然可能的 SP（0–32，竖线每 8 点一格）。色块越深越能解释观测；斜纹表示还没有观测约束这一项。性格和 SP 在对战里看不到，是推断对象；道具、特性、状态和能力等级看得到，直接在卡片上改。",
    en: "Inferred SP: the SP (0–32, a tick every 8) each stat can still have given the recorded hits. Darker explains them better; hatched means nothing constrains that stat yet. Nature and SP cannot be seen in battle, so they are inferred; item, ability, status and stages can, so edit them on the card.",
    ja: "推定SP：記録した観測から、各能力値がまだ取りうるSP（0〜32、8ごとに目盛り）。濃いほど観測をよく説明し、斜線はまだ制約がないことを示します。性格とSPは対戦中に見えないため推定対象、持ち物・特性・状態・ランクは見えるのでカードで直接編集します。" },

  "infer.panel.title": { zh: "{foe}的配置推断", en: "{foe}: inferred build", ja: "{foe} の型推定" },
  "infer.panel.empty": {
    zh: "还没有观测。上面显示的是只按环境剪枝的全部可能。",
    en: "No observations yet. What is shown is everything the environment allows.",
    ja: "まだ観測がありません。表示は環境による絞り込みのみの全候補です。" },
  "infer.space": {
    zh: "按环境剪枝（使用率 ≥1%）：性格 {n} 种 · 道具 {i} 种 · 特性 {a} 种；SP 不剪枝。",
    en: "Cut to the environment (usage ≥1%): {n} natures · {i} items · {a} abilities; SP not cut.",
    ja: "環境で絞り込み（使用率1%以上）：性格 {n} · 持ち物 {i} · 特性 {a}。SPは絞り込みなし。" },
  "infer.space.unpruned": {
    zh: "该宝可梦没有环境数据：性格与特性未剪枝。",
    en: "No usage data for this Pokémon: natures and abilities are not cut.",
    ja: "このポケモンは環境データがないため、性格と特性は絞り込みません。" },
  "infer.states": { zh: "剩余 {pct} 的可能", en: "{pct} of builds remain", ja: "候補の {pct} が残存" },
  "infer.contradiction": {
    zh: "没有任何配置能同时解释全部观测。检查会心、能力等级、场地条件、已确认的道具或特性，或停用某条观测。",
    en: "No build explains every observation. Check crits, stat stages, field conditions and confirmed item or ability, or disable an observation.",
    ja: "すべての観測を説明できる型がありません。急所・ランク・場の状態・確定した持ち物や特性を確認するか、観測を無効にしてください。" },
  "infer.unknown": { zh: "未知", en: "Unknown", ja: "不明" },

  "infer.ruler.def": { zh: "物理耐久 · HP × 防御", en: "Physical bulk · HP × Def", ja: "物理耐久 · HP × 防御" },
  "infer.ruler.spd": { zh: "特殊耐久 · HP × 特防", en: "Special bulk · HP × SpD", ja: "特殊耐久 · HP × 特防" },
  "infer.ruler.eq": { zh: "耐久当量 {lo}–{hi} SP", en: "Bulk equivalent {lo}–{hi} SP", ja: "耐久換算 {lo}〜{hi} SP" },
  "infer.ruler.eqHint": {
    zh: "耐久当量：中性性格下，要在 HP 和该防御上合计投入多少 SP 才能达到同样的 HP × 防御。满投是 64，超过 64 需要加防性格。",
    en: "Bulk equivalent: how many SP split between HP and this defence reach the same HP × defence with a neutral nature. Full investment is 64; beyond needs a boosting nature.",
    ja: "耐久換算：中性性格でHPとこの防御に合計何SP振れば同じHP×防御になるか。全振りで64、それ以上は上昇補正が必要。" },
  "infer.ruler.unobserved": { zh: "未观测", en: "Not observed", ja: "未観測" },
  "infer.ruler.none": { zh: "无可行配置", en: "Nothing fits", ja: "該当なし" },
  "infer.ruler.plusNature": { zh: "+性格", en: "+nature", ja: "+性格" },
  "infer.tend.none": { zh: "无耐久投入", en: "No bulk investment", ja: "耐久無振り" },
  "infer.tend.light": { zh: "倾向无耐", en: "Leans uninvested", ja: "ほぼ無振り" },
  "infer.tend.some": { zh: "有耐久投入", en: "Some bulk", ja: "耐久に振りあり" },
  "infer.tend.heavy": { zh: "重耐久", en: "Heavy bulk", ja: "耐久特化" },
  "infer.tend.open": { zh: "尚难区分", en: "Still open", ja: "まだ判別困難" },

  "infer.lane.atk": { zh: "攻击 SP · 按道具", en: "Atk SP · by item", ja: "攻撃SP · 持ち物別" },
  "infer.lane.spa": { zh: "特攻 SP · 按道具", en: "SpA SP · by item", ja: "特攻SP · 持ち物別" },
  "infer.lane.noBoost": { zh: "无增伤道具", en: "No power item", ja: "火力アイテムなし" },
  "infer.lane.out": { zh: "与观测矛盾", en: "Contradicts the observations", ja: "観測と矛盾" },
  "infer.mult.up": { zh: "加", en: "+", ja: "↑" },
  "infer.mult.neutral": { zh: "中", en: "=", ja: "―" },
  "infer.mult.down": { zh: "减", en: "−", ja: "↓" },

  "infer.foe.adoptedHint": {
    zh: "当前采用的配置：自动填充或手动采用的一套假设，不是观测结果。点名称行的采用按钮可以换一套。",
    en: "The adopted build: an assumption (auto-fill or picked), not an observation. Change it with the Adopted button on the name row.",
    ja: "採用中の型：自動入力または手動で選んだ仮定で、観測結果ではありません。名前行の採用ボタンで変更できます。" },
  "infer.foe.pickHint": {
    zh: "点击选择一套真实配置直接采用（填入性格、SP、道具、特性和招式）；没有采用时为自定义。",
    en: "Pick a real build to adopt (fills nature, SP, item, ability and moves); with none adopted the build is custom.",
    ja: "実戦の型を選んで採用（性格・SP・持ち物・特性・技を入力）。未採用ならカスタム。" },
  "infer.tip.fitCard": {
    zh: "当前采用的这套配置能解释全部观测。",
    en: "The adopted build explains every observation.", ja: "採用中の型はすべての観測を説明できます。" },
  "infer.tip.outCard": {
    zh: "当前采用的这套配置解释不了至少一条观测；这只针对这一套，推断本身是否有解看下方「剩余」比例。",
    en: "The adopted build fails at least one observation. This is about this one build; whether anything fits is the Remaining share below.",
    ja: "採用中の型は少なくとも1つの観測を説明できません。この型だけの判定で、推定全体に解があるかは下の残存割合を見てください。" },
  "infer.sets.unadopt": { zh: "取消采用", en: "Stop using", ja: "採用解除" },
  "infer.sets.unadoptHint": {
    zh: "退回自定义：清空这套配置填入的性格、SP、道具、特性和招式（已确认的道具和特性保留）。",
    en: "Back to custom: clears the nature, SP, item, ability and moves this build filled in (confirmed item and ability stay).",
    ja: "カスタムに戻す：この型で入力した性格・SP・持ち物・特性・技を消去（確定済みの持ち物と特性は残す）。" },
  "infer.tip.coverage": {
    zh: "这类配置（同道具、同特性）在真实队伍里的占比。",
    en: "Share of real teams running this kind of build (same item and ability).",
    ja: "この種類の型（同じ持ち物・特性）の実戦チームでの割合。" },
  "infer.tip.share": {
    zh: "第{n}条观测：16 个伤害随机数中有 {k} 个与这套配置吻合。",
    en: "Observation {n}: {k} of the 16 damage rolls match this build.",
    ja: "観測{n}：16通りの乱数のうち {k} 通りがこの型と一致。" },
  "infer.tip.fit": { zh: "这套配置能解释全部观测。", en: "This build explains every observation.", ja: "この型はすべての観測を説明できます。" },
  "infer.tip.out": { zh: "至少有一条观测这套配置解释不了。", en: "At least one observation rules this build out.", ja: "少なくとも1つの観測がこの型を除外します。" },
  "infer.tip.states": {
    zh: "在按环境剪枝后的全部可能配置（性格 × 道具 × 特性 × 各项 SP）里，仍能解释全部观测的比例。",
    en: "Of every build left after the environment cut (nature × item × ability × each SP), the share that still explains every observation.",
    ja: "環境で絞った全候補（性格×持ち物×特性×各SP）のうち、すべての観測を説明できる割合。" },
  "infer.tip.nature": { zh: "环境使用率 {pct}。", en: "{pct} usage.", ja: "使用率 {pct}。" },
  "infer.tip.natureOut": { zh: "环境使用率 {pct}；已被观测排除。", en: "{pct} usage; ruled out by the observations.", ja: "使用率 {pct}。観測により除外。" },
  "infer.tip.sets": {
    zh: "真实队伍里这只宝可梦的常见配置，按能否解释全部观测排序。",
    en: "This Pokémon's common builds in real teams, ordered by whether they explain every observation.",
    ja: "実戦チームでのこのポケモンのよくある型。すべての観測を説明できるかで並べています。" },
  "infer.tip.spreadShare": { zh: "这个 SP 分配在环境中的占比。", en: "Share of this SP spread in usage data.", ja: "このSP配分の使用率。" },
  "infer.tip.spreadOut": { zh: "无论哪种性格，这个 SP 分配都解释不了观测。", en: "No nature makes this spread fit the observations.", ja: "どの性格でもこの配分は観測と合いません。" },
  "infer.tip.spreadNatureOk": { zh: "这个 SP 分配配合该性格仍然可能。", en: "Still possible with this nature.", ja: "この性格ならまだ可能。" },
  "infer.tip.spreadNatureOut": { zh: "这个 SP 分配配合该性格已被排除。", en: "Ruled out with this nature.", ja: "この性格では除外。" },
  "infer.tip.ruler": {
    zh: "横轴是 HP × {stat}，这一击伤害实际取决于它；下方刻度换算成中性性格下 HP 与{stat}合计投入的 SP。蓝框是仍然可能的范围，柱越高越能解释观测；圆点是真实配置，绿色吻合、红色排除。",
    en: "The axis is HP × {stat}, what the damage actually depends on; the ticks convert it to SP split between HP and {stat} with a neutral nature. The box is what is still possible, taller bars explain the hits better; dots are real builds, green fits and red is ruled out.",
    ja: "横軸は HP×{stat}（ダメージが実際に依存する量）。目盛りは中性性格でHPと{stat}に振った合計SPに換算。枠はまだ可能な範囲、棒が高いほど観測をよく説明。点は実戦の型で、緑は一致、赤は除外。" },
  "infer.tip.unobservedBulk": {
    zh: "还没有打这只宝可梦的{stat}的观测，所以这一项不受约束。",
    en: "No hit on this Pokémon's {stat} recorded yet, so it is unconstrained.",
    ja: "このポケモンの{stat}への攻撃の観測がまだないため、制約なし。" },
  "infer.tip.markFit": { zh: "吻合全部观测", en: "Fits every observation", ja: "すべての観測と一致" },
  "infer.tip.markOut": { zh: "已被观测排除", en: "Ruled out", ja: "除外" },
  "infer.tip.tick": {
    zh: "中性性格下 HP 与{stat}合计投入 {n} SP 能达到的最高耐久。",
    en: "The most bulk {n} SP split between HP and {stat} reach with a neutral nature.",
    ja: "中性性格でHPと{stat}に合計 {n} SP 振ったときの最大耐久。" },
  "infer.tip.plusNature": {
    zh: "HP 与{stat}都投满 32 并带提升{stat}的性格：可能达到的最高耐久。",
    en: "32 SP in both HP and {stat} with a nature raising {stat}: the most bulk possible.",
    ja: "HPと{stat}に32ずつ振り、{stat}上昇補正の性格：到達しうる最大耐久。" },
  "infer.tip.mult.up": { zh: "加：提升{stat}的性格（×1.1）", en: "+: a nature raising {stat} (×1.1)", ja: "↑：{stat}上昇補正の性格（×1.1）" },
  "infer.tip.mult.neutral": { zh: "中：不影响{stat}的性格", en: "=: a nature leaving {stat} alone", ja: "―：{stat}に補正なしの性格" },
  "infer.tip.mult.down": { zh: "减：降低{stat}的性格（×0.9）", en: "−: a nature lowering {stat} (×0.9)", ja: "↓：{stat}下降補正の性格（×0.9）" },
  "infer.tip.lanes": {
    zh: "每一组是一种道具假设，每行是一类性格；色块是在该道具和性格下仍能解释观测的{stat} SP（0–32，竖线每 8 点一格）。整组划掉表示该道具与观测矛盾。",
    en: "Each group is an item hypothesis and each row a nature class; filled cells are the {stat} SP (0–32, a tick every 8) that still explain the hits with that item and nature. A struck group contradicts the hits.",
    ja: "グループごとに持ち物の仮定、行ごとに性格の種類。塗られたマスはその持ち物と性格で観測を説明できる{stat}SP（0〜32、8ごとに目盛り）。取り消し線のグループは観測と矛盾。" },
  "infer.tip.unobservedLanes": {
    zh: "还没有这只宝可梦用{stat}招式打我方的观测。",
    en: "No hit from this Pokémon's {stat} moves recorded yet.",
    ja: "このポケモンの{stat}技による観測がまだありません。" },
  "infer.tip.laneOut": {
    zh: "带这个道具时，没有任何{stat} SP 和性格能解释观测。",
    en: "With this item no {stat} SP and nature explain the hits.",
    ja: "この持ち物では、どの{stat}SPと性格でも観測を説明できません。" },
  "infer.tip.laneCells": {
    zh: "色块：仍能解释观测的{stat} SP。",
    en: "Filled: {stat} SP that still explain the hits.", ja: "塗り：観測を説明できる{stat}SP。" },
  "infer.tip.laneSpan": { zh: "仍然可能的{stat} SP 范围", en: "{stat} SP still possible", ja: "まだ可能な{stat}SP" },
  "infer.log.title": { zh: "{foe}的观测记录", en: "Observations on {foe}", ja: "{foe} の観測記録" },
  "infer.log.hint": {
    zh: "每条记录附带加入时冻结的条件；可以停用或删除来比较结果。",
    en: "Each record keeps the conditions frozen when it was added; disable or remove one to compare.",
    ja: "各記録には追加時の条件が保存されます。無効化や削除で比較できます。" },
  "infer.log.empty": {
    zh: "还没有观测。在下方卡片选中招式，填入实际血量后加入。",
    en: "No observations yet. Select a move on a card below and enter the HP you saw.",
    ja: "まだ観測がありません。下のカードで技を選び、実際のHPを入力して追加してください。" },
  "infer.log.impossible": {
    zh: "无效结果。最接近的可能结果：剩 {values}",
    en: "Invalid result. Nearest possible readings: {values} left",
    ja: "無効な結果。最も近い可能な結果：残り {values}" },
  "infer.log.impossibleHint": {
    zh: "当前候选范围无法解释这条观测，已暂停用它收窄配置。请核对血量、道具触发、会心、能力等级与场地条件；低使用率配置可能不在候选范围内。",
    en: "No candidate explains this observation, so it does not narrow the builds. Check HP, item activation, critical hits, stages and field conditions. Low-usage builds may be outside this model.",
    ja: "候補内で説明できないため、この観測では候補を絞りません。HP、持ち物の発動、急所、能力ランク、場を確認してください。低使用率の型は候補外の場合があります。" },
  "infer.empty": { zh: "没有可预测的配置", en: "No build to predict", ja: "予測できる型がありません" },
  "infer.log.noFrame": { zh: "无特殊条件", en: "No special conditions", ja: "特別な条件なし" },
  "infer.log.remainingHint": {
    zh: "加入这条（及之前各条）观测后，仍能解释它们的配置所占比例。",
    en: "Share of builds still explaining this and every earlier observation.",
    ja: "この観測とそれ以前の観測をすべて説明できる型の割合。" },
  "infer.sets": { zh: "真实配置", en: "Real builds", ja: "実戦の型" },
  "infer.sets.fit": { zh: "吻合", en: "Fits", ja: "一致" },
  "infer.sets.out": { zh: "排除", en: "Ruled out", ja: "除外" },
  "infer.sets.apply": { zh: "采用", en: "Use", ja: "採用" },
  "infer.sets.adopted": { zh: "已采用", en: "In use", ja: "採用中" },
  "infer.sets.applyHint": { zh: "把这套配置写入对方的这只宝可梦（计算器和耐久调整会同步使用）",
    en: "Write this build to their Pokémon (the calculator and bulk tune use it too)",
    ja: "この型を相手のポケモンに反映（計算機と耐久調整にも反映）" },
  "infer.sets.none": { zh: "未找到吻合的真实配置", en: "No real build fits", ja: "一致する実戦の型なし" },
  "infer.sets.nearest": { zh: "最接近：{set}，需调整约 {n} SP（{diff}）", en: "Closest: {set}, about {n} SP off ({diff})",
    ja: "最も近い：{set}、約 {n} SP の差（{diff}）" },
  "infer.sets.nearestNature": {
    zh: "最接近：{set}，SP 不变、把性格改为{nature}即可吻合",
    en: "Closest: {set}; same SP, it fits with a {nature} nature",
    ja: "最も近い：{set}。SPはそのまま、性格を{nature}にすれば一致" },
  "infer.sets.natureChange": { zh: "性格改为{nature}", en: "nature → {nature}", ja: "性格→{nature}" },
  "infer.sets.empty": { zh: "该宝可梦没有真实配置数据。", en: "No real-build data for this Pokémon.",
    ja: "このポケモンの実戦の型データはありません。" },
  "infer.sets.coverage": { zh: "占比 {pct}", en: "{pct} share", ja: "{pct}" },
  "infer.meta": { zh: "环境常见 SP 分配", en: "Common SP spreads", ja: "環境でよくあるSP配分" },
  "infer.meta.hint": {
    zh: "来自环境的 SP 分配统计（不含性格和道具）；绿色是仍能吻合的性格，划线是被排除的。",
    en: "SP spreads from usage data (no nature or item); green natures still fit, struck ones are ruled out.",
    ja: "環境のSP配分統計（性格・持ち物なし）。緑は一致する性格、取り消し線は除外。" },
  "infer.meta.out": { zh: "全部排除", en: "All ruled out", ja: "すべて除外" },

  "infer.log.remaining": { zh: "剩 {pct}", en: "{pct} left", ja: "残 {pct}" },
  "infer.log.disable": { zh: "停用", en: "Disable", ja: "無効化" },
  "infer.log.enable": { zh: "启用", en: "Enable", ja: "有効化" },
  "infer.log.remove": { zh: "删除", en: "Remove", ja: "削除" },
  "infer.log.crit": { zh: "会心", en: "crit", ja: "急所" },
  "infer.log.single": { zh: "单目标", en: "single target", ja: "単体" },
} as const;

export const useInferT = defineMessages(INFER_MESSAGES);
