/** The KO axis for one Pokemon: who it knocks out, who knocks it out.
 *
 * A SEPARATE block below the usage panel grid rather than another panel inside it: it is a
 * different upstream on a different snapshot clock, so it must not inherit the usage panels'
 * freshness by sitting among them. The DTO still carries `updatedAt`/`snapshotId` for callers that
 * need the provenance; the page itself keeps the block visually separate instead of printing it.
 *
 * Three things the rendering deliberately refuses to do, each matching a property of the data:
 *   - no in-row usage bar. The source publishes an ORDERING and no count, so a bar sized from the
 *     rank would be a number we invented.
 *   - no green/red for the two directions. The matchup grid already owns the whole
 *     red-orange-amber-green KO ramp plus the check-grade colors, so a warm/green split here reads
 *     as a verdict. Direction is the A/B build-label pair (blue outgoing, violet incoming) plus an
 *     arrow glyph, which also survives grayscale and color-vision deficiency.
 *   - no de-duplication. The same species can appear twice because the underlying rows are per-form
 *     and the source drops the form; both entries stay and carry the `形` marker.
 *
 * Each direction's move list renders UNDER its own sprite grid. While `coverage.moveShare` is
 * "absent" the panel is `null` — not collected — and says so rather than disappearing, which a
 * reader would take for "this Pokemon knocks nothing out with anything".
 *
 * Every row hovers into a history sparkline, from the KO axis's OWN trend document: an opponent's
 * series is a RANK (the source publishes an ordering), a move's is a percentage. Both are lazy —
 * the fetch starts the first time a reader opens one.
 *
 * Clicking an opponent goes to ITS metagame page in the same format, not to its dex card: the
 * reader is comparing metagame facts, so the next thing they want is the same kind of page.
 */
import type {
  FormatId, KoEntryDto, KoMoveEntryDto, MetaKoDto, MetaKoTrendDto,
} from "@pokemon-champions/protocol";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { GameImage } from "./GameImage.tsx";
import { Link } from "react-router-dom";
import { EntityHover } from "./EntityHover.tsx";
import { CategoryBadge, TypeBadge } from "./TypeBadge.tsx";
import { RankMiniTrend, UsageMiniTrend } from "./UsageMiniTrend.tsx";
import { displayName, useLang, useT } from "../i18n.ts";
import type { Async } from "../hooks.ts";

type KoPanelKey = "koTargets" | "koedBy";

/** One place that turns "this row, in this direction" into its sparkline, so the two panels and the
 * four series kinds cannot drift apart. */
function useKoTrendPreview(trend: Async<MetaKoTrendDto | null>) {
  const state = trend.status === "loading" ? "loading"
    : trend.status === "error" ? "error"
      : trend.status === "ready" && trend.data ? "ready" : "missing";
  const periods = trend.status === "ready" && trend.data ? trend.data.periods : [];
  return {
    mon(panel: KoPanelKey, nationalDex: number) {
      const series = trend.status === "ready" && trend.data
        ? trend.data.panels[panel].find((s) => s.nationalDex === nationalDex) : undefined;
      return <RankMiniTrend periods={periods} values={series?.ranks}
        state={state === "ready" && !series ? "missing" : state} />;
    },
    move(panel: KoPanelKey, name: string) {
      const key = panel === "koTargets" ? "koMoves" : "koedByMoves";
      const series = trend.status === "ready" && trend.data
        ? trend.data.panels[key].find((s) => s.name === name) : undefined;
      return <UsageMiniTrend periods={periods} values={series?.values}
        state={state === "ready" && !series ? "missing" : state} />;
    },
  };
}

/** Past this usage rank the opponent is a rare pick, so its KO position is a signal rather than
 * exposure — worth marking, because that distinction is the whole reason the column exists. */
const RARE_USAGE_RANK = 60;

function KoMon({ entry, href, addon, onPreviewOpen, picked, onPick, pickFull }: {
  entry: KoEntryDto;
  href?: string;
  addon: ReactNode;
  onPreviewOpen: () => void;
  picked: boolean;
  /** Absent when the page does not collect picks (nothing to hand anywhere). */
  onPick?: (slug: string) => void;
  pickFull: boolean;
}) {
  const { lang } = useLang();
  const t = useT();
  const label = displayName(entry, lang);
  const rare = entry.usageRank != null && entry.usageRank > RARE_USAGE_RANK;
  const slug = entry.slug ?? "";
  const locked = !slug || (pickFull && !picked);
  // The portrait picks, the NAME travels. One tile, two acts, each with its own target — which is
  // what lets the grid double as a roster picker without losing the way into each Pokemon.
  return (
    <div className={`ko-mon${picked ? " picked" : ""}`}>
      <EntityHover kind="pokemon" name={entry.name} link={false} passive previewAddon={addon}
                   onPreviewOpen={onPreviewOpen}>
        <span className={`ko-thumb${onPick ? " pickable" : ""}${locked ? " locked" : ""}`}
              {...(onPick ? {
                role: "button", tabIndex: locked ? -1 : 0,
                "aria-pressed": picked, "aria-disabled": locked || undefined,
                title: t("detail.pickRow"),
                onClick: () => { if (!locked) onPick(slug); },
                onKeyDown: (e: ReactKeyboardEvent<HTMLSpanElement>) => {
                  if (locked) return;
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(slug); }
                },
              } : {})}>
          <span className="ko-badge num">{entry.rank}</span>
          {entry.formCollapsed && (
            <span className="ko-fc" title={t("ko.formCollapsed")} aria-label={t("ko.formCollapsed")}>形</span>
          )}
          <GameImage assetKey={entry.key ?? `pokemon:${entry.slug ?? ""}`} role="dense" alt={label} />
          {picked && <span className="ko-tick" aria-hidden>✓</span>}
        </span>
      </EntityHover>
      {href ? <Link className="ko-nm" to={href}>{label}</Link> : <span className="ko-nm">{label}</span>}
      <span className={`ko-use num${rare ? " rare" : ""}`} title={t("ko.usageRank")}>
        {entry.usageRank != null ? `#${entry.usageRank}` : "—"}
      </span>
    </div>
  );
}

function KoMoveRows({ moves, addon, onPreviewOpen }: {
  moves: KoMoveEntryDto[];
  addon: (name: string) => ReactNode;
  onPreviewOpen: () => void;
}) {
  const { lang } = useLang();
  return (
    <div className="rows">
      {moves.map((m) => (
        <div className="p-row" key={`${m.rank}-${m.name}`}
             style={m.percentage == null ? undefined : {
               background: `linear-gradient(to right, var(--pct-fill) ${m.percentage}%, transparent ${m.percentage}%)`,
             }}>
          <span className="p-rank num">{m.rank}</span>
          <span className="p-name">
            <EntityHover kind="move" name={m.name} previewAddon={addon(m.name)}
                         onPreviewOpen={onPreviewOpen}>
              <span className="p-inner">
                <TypeBadge type={m.type} iconOnly />
                <CategoryBadge category={m.category} />
                {displayName(m, lang)}
              </span>
            </EntityHover>
          </span>
          <span className="p-pct num">
            {m.percentage != null ? `${m.percentage.toFixed(1)}%` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function KoPanel({ outgoing, entries, moves, format, preview, onPreviewOpen,
                  picked, onPick, pickFull }: {
  outgoing: boolean;
  entries: KoEntryDto[];
  moves: KoMoveEntryDto[] | null;
  format: FormatId;
  preview: ReturnType<typeof useKoTrendPreview>;
  onPreviewOpen: () => void;
  picked: (slug: string) => boolean;
  onPick?: (slug: string) => void;
  pickFull: boolean;
}) {
  const t = useT();
  const panel: KoPanelKey = outgoing ? "koTargets" : "koedBy";
  return (
    <section className={`panel ko-panel ${outgoing ? "out" : "in"}`}>
      <h2 className="ko-dir">
        <span className="arrow num" aria-hidden="true">{outgoing ? "→" : "←"}</span>
        {t(outgoing ? "ko.targets" : "ko.koedBy")}
        <span className="ko-note">{t("ko.orderOnly")}</span>
      </h2>
      <div className="ko-grid">
        {entries.map((e) => (
          <KoMon entry={e} key={`${e.rank}-${e.nationalDex}`}
                 href={e.slug ? `/meta/${e.slug}?format=${format}` : undefined}
                 addon={preview.mon(panel, e.nationalDex)} onPreviewOpen={onPreviewOpen}
                 picked={picked(e.slug ?? "")} onPick={onPick} pickFull={pickFull} />
        ))}
      </div>
      <div className="ko-moves">
        <span className="lbl">{t(outgoing ? "ko.moves" : "ko.koedByMoves")}</span>
        {moves === null
          // null = the tier was not collected. An empty list would claim the source reported none,
          // so the slot stays and says which of the two it is.
          ? <span className="ko-absent"><span className="dot" aria-hidden="true" />{t("ko.movesAbsent")}</span>
          : <KoMoveRows moves={moves} addon={(name) => preview.move(panel, name)}
                        onPreviewOpen={onPreviewOpen} />}
      </div>
    </section>
  );
}

export function KoBlock({ ko, trend, format, onPreviewOpen, picked, onPick, pickFull = false }: {
  ko: Async<MetaKoDto>;
  /** The KO axis's own history. Lazy: `onPreviewOpen` is what starts the fetch. */
  trend: Async<MetaKoTrendDto | null>;
  format: FormatId;
  onPreviewOpen: () => void;
  /** Both panels share ONE selection: they name one defending roster, and how a mon got onto it
   * does not make it two. */
  picked?: (slug: string) => boolean;
  onPick?: (slug: string) => void;
  pickFull?: boolean;
}) {
  const t = useT();
  const preview = useKoTrendPreview(trend);
  if (ko.status === "loading") return null;
  if (ko.status === "error") {
    // 404 is the factual "this snapshot was not collected"; anything else is a real load failure
    // and must not be dressed up as a metagame fact (same split as the detail panels).
    return (
      <div className="notice ko-notice">
        {ko.httpStatus === 404 ? t("ko.missing") : t("state.errorDetail")}
      </div>
    );
  }
  const { panels, coverage } = ko.data;
  return (
    <section className="ko-block">
      <div className="ko-head">
        <h2>{t("ko.section")}</h2>
      </div>
      <div className="ko-duo">
        <KoPanel outgoing entries={panels.koTargets} format={format}
                 preview={preview} onPreviewOpen={onPreviewOpen}
                 picked={picked ?? (() => false)} onPick={onPick} pickFull={pickFull}
                 moves={coverage.moveShare === "absent" ? null : panels.koMoves} />
        <KoPanel outgoing={false} entries={panels.koedBy} format={format}
                 preview={preview} onPreviewOpen={onPreviewOpen}
                 picked={picked ?? (() => false)} onPick={onPick} pickFull={pickFull}
                 moves={coverage.moveShare === "absent" ? null : panels.koedByMoves} />
      </div>
    </section>
  );
}
