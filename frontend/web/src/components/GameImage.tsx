/** Pokemon/item image with honest three-tier resolution (design §12): exact renders the
 * pack file, base_fallback renders it WITH a visible note, placeholder renders the bundled
 * original art — never a guessed file, never a disguised fallback. */
import type { AssetRole } from "@pokemon-champions/protocol";
import { createContext, useContext, useEffect, useState } from "react";
import { PLACEHOLDERS } from "../assets/icons.ts";
import { resolveImage, type ResolvedImage } from "../assets/images.ts";
import { useT } from "../i18n.ts";

/** True inside an off-screen render that is about to be captured as a picture (the metagame share
 * image): lazy loading would leave anything outside the viewport blank in the capture. */
export const EagerImages = createContext(false);

interface Props {
  assetKey: string;                    // "pokemon:<slug>" | "item:<slug>"
  role: AssetRole;
  alt: string;
  className?: string;
}

export function GameImage({ assetKey, role, alt, className }: Props) {
  const [img, setImg] = useState<ResolvedImage | null>(null);
  const eager = useContext(EagerImages);
  const t = useT();
  useEffect(() => {
    let cancelled = false;
    resolveImage(assetKey, role).then((r) => { if (!cancelled) setImg(r); });
    return () => { cancelled = true; };
  }, [assetKey, role]);

  const loading = eager ? "eager" : "lazy";
  const kind = assetKey.startsWith("item:") ? "item" : "pokemon";
  if (!img || img.tier === "placeholder" || !img.url) {
    // `data-img-pending` marks the placeholder shown while resolution is still running, so a
    // capture can wait for the real file instead of photographing the stand-in.
    return <img className={className} src={PLACEHOLDERS[kind]} alt={alt} loading={loading}
      data-img-pending={img ? undefined : ""} />;
  }
  return (
    <>
      <img className={className} src={img.url} alt={alt} loading={loading} />
      {img.tier === "base_fallback" && (
        <span className="img-fallback-note">{t("img.baseFallback")}</span>
      )}
    </>
  );
}
