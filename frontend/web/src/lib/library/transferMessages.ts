/** Copy of what pages offer the library workspace: their receivers ("fill our team") and sources
 * ("keep our team"). It lives beside the workspace but loads with the pages that use it
 * (`defineMessages`), not with the entry bundle. */
import { defineMessages } from "../../i18n.ts";

export const useTransferT = defineMessages({
  "transfer.calc.teamOurs": { zh: "我方队伍", en: "Our team", ja: "自分のチーム" },
  "transfer.calc.teamTheirs": { zh: "对方队伍", en: "Their team", ja: "相手のチーム" },
  "transfer.calc.monOurs": { zh: "加入我方", en: "Add to our side", ja: "自分側に追加" },
  "transfer.calc.monTheirs": { zh: "加入对方", en: "Add to their side", ja: "相手側に追加" },
  "transfer.calc.keepMonOurs": { zh: "我方选中宝可梦", en: "Our selected Pokémon", ja: "自分の選択中ポケモン" },
  "transfer.calc.keepMonTheirs": { zh: "对方选中宝可梦", en: "Their selected Pokémon", ja: "相手の選択中ポケモン" },
  "transfer.calc.saveOurs": { zh: "我方全队", en: "Our whole team", ja: "自分のチーム全体" },
  "transfer.calc.saveTheirs": { zh: "对方全队", en: "Their whole team", ja: "相手のチーム全体" },
  "transfer.calc.full": {
    zh: "这一侧已经有 6 只了", en: "That side already holds six", ja: "この側はすでに6匹です" },
  "transfer.matchup.team": { zh: "设为我方队伍", en: "Use as our team", ja: "自分のチームにする" },
  "transfer.matchup.mon": { zh: "加入我方配置", en: "Add to our builds", ja: "自分の型に追加" },
  "transfer.matchup.full": {
    zh: "已经有 6 个配置了", en: "Six builds are already listed", ja: "型はすでに6件あります" },
  "transfer.matchup.save": { zh: "保存当前队伍", en: "Save current team", ja: "現在のチームを保存" },
  "transfer.diagnose.team": { zh: "填入诊断", en: "Put in the diagnosis", ja: "診断に入れる" },
  "transfer.diagnose.save": { zh: "保存诊断过的队伍", en: "Save the diagnosed team", ja: "診断したチームを保存" },
  "transfer.builder.box": {
    zh: "用箱子作为持有列表", en: "Use the boxes as owned Pokémon", ja: "ボックスを手持ちにする" },
  "transfer.builder.mon": { zh: "加入持有列表", en: "Add to owned Pokémon", ja: "手持ちに追加" },
  "transfer.builder.capped": {
    zh: "持有列表最多 {n} 种，已放入前 {n} 种", en: "Owned Pokémon take at most {n}; the first {n} went in",
    ja: "手持ちは最大 {n} 種のため、先頭の {n} 種を入れました" },
  "transfer.builder.save": { zh: "保存建队结果", en: "Save the built team", ja: "構築結果を保存" },
  "transfer.session.save": { zh: "保存推荐队伍", en: "Save the recommended team", ja: "推奨チームを保存" },
  "transfer.meta.save": { zh: "当前配置", en: "This build", ja: "この型" },
  "transfer.unreadable": {
    zh: "没有能识别的宝可梦", en: "No Pokémon this page recognises", ja: "認識できるポケモンがいません" },
});
