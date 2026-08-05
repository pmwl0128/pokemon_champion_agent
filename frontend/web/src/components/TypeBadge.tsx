import { categoryIconUrl, typeIconUrl } from "../assets/icons.ts";

const TYPE_LABELS: Record<string, { zh: string; en: string; ja: string }> = {
  Normal: { zh: "一般", en: "Normal", ja: "ノーマル" },
  Fire: { zh: "火", en: "Fire", ja: "ほのお" },
  Water: { zh: "水", en: "Water", ja: "みず" },
  Electric: { zh: "电", en: "Electric", ja: "でんき" },
  Grass: { zh: "草", en: "Grass", ja: "くさ" },
  Ice: { zh: "冰", en: "Ice", ja: "こおり" },
  Fighting: { zh: "格斗", en: "Fighting", ja: "かくとう" },
  Poison: { zh: "毒", en: "Poison", ja: "どく" },
  Ground: { zh: "地面", en: "Ground", ja: "じめん" },
  Flying: { zh: "飞行", en: "Flying", ja: "ひこう" },
  Psychic: { zh: "超能力", en: "Psychic", ja: "エスパー" },
  Bug: { zh: "虫", en: "Bug", ja: "むし" },
  Rock: { zh: "岩石", en: "Rock", ja: "いわ" },
  Ghost: { zh: "幽灵", en: "Ghost", ja: "ゴースト" },
  Dragon: { zh: "龙", en: "Dragon", ja: "ドラゴン" },
  Dark: { zh: "恶", en: "Dark", ja: "あく" },
  Steel: { zh: "钢", en: "Steel", ja: "はがね" },
  Fairy: { zh: "妖精", en: "Fairy", ja: "フェアリー" },
  Typeless: { zh: "无属性", en: "Typeless", ja: "タイプなし" },
};
const CATEGORY_LABELS: Record<string, { zh: string; en: string; ja: string }> = {
  Physical: { zh: "物理", en: "Physical", ja: "ぶつり" },
  Special: { zh: "特殊", en: "Special", ja: "とくしゅ" },
  Status: { zh: "变化", en: "Status", ja: "へんか" },
};

import { useLang } from "../i18n.ts";

export function TypeBadge({ type, iconOnly = false }: { type: string; iconOnly?: boolean }) {
  const { lang } = useLang();
  const url = typeIconUrl(type);
  const label = TYPE_LABELS[type]?.[lang] ?? type;
  return (
    <span className={`type-badge${iconOnly ? " icon-only" : ""}`} title={label}>
      {url && <img src={url} alt={label} />}
      {!iconOnly && label}
    </span>
  );
}

export function CategoryBadge({ category, iconOnly = true }: { category: string; iconOnly?: boolean }) {
  const { lang } = useLang();
  const url = categoryIconUrl(category);
  const label = CATEGORY_LABELS[category]?.[lang] ?? category;
  return (
    <span className={`type-badge${iconOnly ? " icon-only" : ""}`} title={label}>
      {url && <img src={url} alt={label} />}
      {!iconOnly && label}
    </span>
  );
}
