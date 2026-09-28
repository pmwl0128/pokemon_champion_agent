/** "导出": a panel as text on the clipboard, or as a PNG of the panel at three sizes (its own width at
 * 1x, 2x and 3x). The team card and the matchup inspector both export through this one menu. */
import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../i18n.ts";
import { copyText, saveBlob } from "../lib/download.ts";
import { roveFocus, useFocusOnOpen, usePopover } from "../lib/popover.ts";

const EXPORT_SCALES = [1, 2, 3] as const;
const TIER_KEY = { 1: "team.export.tier1", 2: "team.export.tier2", 3: "team.export.tier3" } as const;

/** Wait for web fonts and every sprite in the panel, so the picture never shows a placeholder. */
async function settle(root: HTMLElement): Promise<void> {
  await document.fonts?.ready;
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    const images = Array.from(root.querySelectorAll("img"));
    if (!root.querySelector("[data-img-pending]") && images.every((img) => img.complete)) break;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/** One more way out of the menu that only some panels have (the library's own file). */
export interface ExtraExport {
  label: string;
  hint: string;
  run: () => void;
}

export function ExportMenu({ text, textHint, shot, fileName, exclude, extra, className = "" }: {
  /** The text to copy; read when chosen. */
  text: string | (() => string);
  textHint?: string;
  shot: RefObject<HTMLElement | null>;
  /** The PNG's file name at a scale. */
  fileName: (scale: number) => string;
  /** Selector of parts of `shot` the picture leaves out (the menu's own button row). */
  exclude?: string;
  extra?: ExtraExport;
  className?: string;
}) {
  const t = useT();
  const pop = usePopover<HTMLSpanElement>();
  const list = useRef<HTMLDivElement>(null);
  useFocusOnOpen(pop.open, list, "button");
  const [status, setStatus] = useState<"idle" | "copied" | "saved" | "working" | "failed">("idle");
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (pop.open) setWidth(Math.round(shot.current?.getBoundingClientRect().width ?? 0));
  }, [pop.open, shot]);
  const flash = (next: typeof status) => {
    setStatus(next);
    if (next !== "working") window.setTimeout(() => setStatus("idle"), 1800);
  };
  const copy = async () => {
    pop.setOpen(false);
    flash(await copyText(typeof text === "function" ? text() : text) ? "copied" : "failed");
  };
  const save = async (scale: number) => {
    const node = shot.current;
    pop.setOpen(false);
    if (!node) return;
    setStatus("working");
    try {
      const { domToBlob } = await import("modern-screenshot");
      await settle(node);
      const background = getComputedStyle(node).getPropertyValue("--panel").trim() || "#ffffff";
      const blob = await domToBlob(node, {
        scale, backgroundColor: background, type: "image/png",
        ...(exclude ? { filter: (child: Node) => !(child instanceof Element && child.matches(exclude)) } : {}),
      });
      saveBlob(blob, fileName(scale));
      flash("saved");
    } catch (error) {
      console.error("image export failed:", error);
      flash("failed");
    }
  };
  const label = status === "copied" ? t("team.copied") : status === "saved" ? t("team.export.saved")
    : status === "working" ? t("team.export.working") : t("team.export");
  return (
    <span className={`team-export${className ? ` ${className}` : ""}`} ref={pop.wrap} onBlur={pop.onBlur}>
      <button ref={pop.trigger} type="button" className={`second-btn team-export-btn${pop.open ? " open" : ""}`}
        aria-haspopup="menu" aria-expanded={pop.open} disabled={status === "working"}
        onClick={pop.toggle}>
        {label}
        <svg viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" /></svg>
      </button>
      {status === "failed" && <span className="muted team-export-failed">{t("team.copyFailed")}</span>}
      {pop.open && (
        <div ref={list} className="team-export-pop" role="menu" aria-label={t("team.export")}
             onKeyDown={(event) => roveFocus(event, "button")}>
          <button type="button" role="menuitem" className="team-export-row" onClick={() => void copy()}>
            <b>{t("team.export.text")}</b>
            {textHint && <small>{textHint}</small>}
          </button>
          {extra && (
            <button type="button" role="menuitem" className="team-export-row"
                    onClick={() => { pop.setOpen(false); extra.run(); }}>
              <b>{extra.label}</b>
              <small>{extra.hint}</small>
            </button>
          )}
          <div className="team-export-sep" role="separator" />
          <div className="team-export-cap">{t("team.export.image")}</div>
          {EXPORT_SCALES.map((scale) => (
            <button key={scale} type="button" role="menuitem" className="team-export-row"
                    onClick={() => void save(scale)}>
              <b>{t(TIER_KEY[scale])}</b>
              {width > 0 && <small className="num">{width * scale} px</small>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
