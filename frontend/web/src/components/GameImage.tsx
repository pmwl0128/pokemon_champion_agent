/** Pokemon/item image with honest three-tier resolution (design §12): exact renders the
 * pack file, base_fallback renders it WITH a visible note, placeholder renders the bundled
 * original art — never a guessed file, never a disguised fallback. */
import type { AssetRole } from "@pokemon-champions/protocol";
import { useEffect, useState } from "react";
import { PLACEHOLDERS } from "../assets/icons.ts";
import { resolveImage, type ResolvedImage } from "../assets/images.ts";
import { useT } from "../i18n.ts";

interface Props {
  assetKey: string;                    // "pokemon:<slug>" | "item:<slug>"
  role: AssetRole;
  alt: string;
  className?: string;
}

export function GameImage({ assetKey, role, alt, className }: Props) {
  const [img, setImg] = useState<ResolvedImage | null>(null);
  const t = useT();
  useEffect(() => {
    let cancelled = false;
    resolveImage(assetKey, role).then((r) => { if (!cancelled) setImg(r); });
    return () => { cancelled = true; };
  }, [assetKey, role]);

  const kind = assetKey.startsWith("item:") ? "item" : "pokemon";
  if (!img || img.tier === "placeholder" || !img.url) {
    return <img className={className} src={PLACEHOLDERS[kind]} alt={alt} loading="lazy" />;
  }
  return (
    <>
      <img className={className} src={img.url} alt={alt} loading="lazy" />
      {img.tier === "base_fallback" && (
        <span className="img-fallback-note">{t("img.baseFallback")}</span>
      )}
    </>
  );
}
