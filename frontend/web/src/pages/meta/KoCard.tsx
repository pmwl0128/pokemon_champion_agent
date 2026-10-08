/** The KO card: who this Pokemon knocks out, and who knocks it out.
 *
 * Its own card with its own stamp, never a panel of the usage card: it is a different upstream on a
 * different snapshot clock (frontend/design.md §7.1.1), so it must not borrow the usage card's date.
 *
 * What the rendering refuses to do, each following a property of the data:
 *   - no share on an opponent. The source publishes an ORDERING and no count; the tile shows the
 *     order and, separately, that opponent's own usage rank, which is what lets a reader discount a
 *     KO position that is really just exposure.
 *   - no green/red for the two directions. The matchup grid already owns the KO ramp and the check
 *     grades; direction here is the A/B build-label pair (blue outgoing, violet incoming) plus an
 *     arrow, which also survives grayscale and colour-vision deficiency.
 *   - no de-duplication. The same species can appear twice because the source drops the form; both
 *     entries stay and carry the `形` marker.
 *   - no disappearing move list. While `coverage.moveShare` is "absent" the move panel is null — not
 *     collected — and a placeholder of the same height says so, instead of reading as "knocks
 *     nothing out with anything".
 *
 * Opponent and move histories come from the KO axis's own trend document, fetched the first time a
 * reader opens one of those previews. */
import type {
  FormatId, KoMoveEntryDto, MetaKoDto, MetaKoTrendDto,
} from "@pokemon-champions/protocol";
import { CategoryBadge, TypeBadge } from "../../components/TypeBadge.tsx";
import type { Async } from "../../hooks.ts";
import { displayName, useLang, useT } from "../../i18n.ts";
import { MonTile } from "./MonTile.tsx";
import { TrendAddon, UsageRow } from "./rows.tsx";

type Side = "koTargets" | "koedBy";

/** Local wall-clock "YYYY-MM-DD HH:mm" — the reader's own time zone, same form in every language. */
export function stampTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function MoveList({ moves, trend, side, onPreviewOpen }: {
  moves: KoMoveEntryDto[];
  trend: Async<MetaKoTrendDto | null>;
  side: Side;
  onPreviewOpen?: () => void;
}) {
  const { lang } = useLang();
  const key = side === "koTargets" ? "koMoves" : "koedByMoves";
  const half = Math.ceil(moves.length / 2);
  const column = (list: KoMoveEntryDto[]) => (
    <div className="mc-ko-movecol">
      {list.map((m) => {
        const values = trend.status === "ready" && trend.data
          ? trend.data.panels[key].find((s) => s.name === m.name)?.values : undefined;
        return (
          <UsageRow key={`${m.rank}-${m.name}`} rank={m.rank} lead={m.rank === 1} pct={m.percentage}
                    hover={{ kind: "move", name: m.name, onOpen: onPreviewOpen,
                             addon: <TrendAddon trend={trend} values={values} kind="pct" /> }}>
            <TypeBadge type={m.type} iconOnly />
            <CategoryBadge category={m.category} />
            <span className="mc-text">{displayName(m, lang)}</span>
          </UsageRow>
        );
      })}
    </div>
  );
  return <div className="mc-ko-moves">{column(moves.slice(0, half))}{column(moves.slice(half))}</div>;
}

function KoSide({ ko, side, trend, format, onPreviewOpen }: {
  ko: MetaKoDto;
  side: Side;
  trend: Async<MetaKoTrendDto | null>;
  format: FormatId;
  onPreviewOpen?: () => void;
}) {
  const t = useT();
  const outgoing = side === "koTargets";
  const moves = ko.coverage.moveShare === "absent" ? null
    : outgoing ? ko.panels.koMoves : ko.panels.koedByMoves;
  return (
    <div className={`mc-ko-side ${outgoing ? "out" : "in"}`}>
      <div className="mc-ko-dir">
        <span className="mc-ko-arrow" aria-hidden="true">{outgoing ? "→" : "←"}</span>
        {t(outgoing ? "ko.targets" : "ko.koedBy")}
      </div>
      <div className="mc-tiles">
        {ko.panels[side].map((e) => {
          const ranks = trend.status === "ready" && trend.data
            ? trend.data.panels[side].find((s) => s.nationalDex === e.nationalDex)?.ranks : undefined;
          return (
            <MonTile key={`${e.rank}-${e.nationalDex}`} entry={e} format={format}
                     onPreviewOpen={onPreviewOpen}
                     addon={<TrendAddon trend={trend} values={ranks} kind="rank" />} />
          );
        })}
      </div>
      <div className="mc-ko-movehead">
        <span>{t(outgoing ? "ko.moves" : "ko.koedByMoves")}</span>
        <span>{t("mc.pct")}</span>
      </div>
      {moves === null
        // null = the tier was not collected. An empty list would claim the source reported none.
        ? <div className="mc-ko-absent"><span>{t("mc.ko.movesAbsent")}</span></div>
        : <MoveList moves={moves} trend={trend} side={side} onPreviewOpen={onPreviewOpen} />}
    </div>
  );
}

export function KoCard({ ko, trend, format, onPreviewOpen }: {
  ko: Async<MetaKoDto>;
  /** The KO axis's own history. Lazy: `onPreviewOpen` is what starts the fetch. */
  trend: Async<MetaKoTrendDto | null>;
  format: FormatId;
  onPreviewOpen?: () => void;
}) {
  const t = useT();
  if (ko.status === "loading") return null;
  if (ko.status === "error") {
    // 404 is the factual "this snapshot was not collected"; anything else is a real load failure
    // and must not be dressed up as a metagame fact.
    return (
      <section className="mc-card mc-ko mc-ko-missing">
        {ko.httpStatus === 404 ? t("ko.missing") : t("state.errorDetail")}
      </section>
    );
  }
  const data = ko.data;
  const snapshot = data.snapshotId != null
    ? t("mc.ko.snapshot").replace("{id}", String(data.snapshotId))
      .replace("{time}", stampTime(data.updatedAt))
    : t("mc.ko.updated").replace("{time}", stampTime(data.updatedAt));
  return (
    <section className="mc-card mc-ko" aria-label={t("ko.section")}>
      <header className="mc-ko-head">
        <h2>{t("ko.section")}</h2>
        <span className="mc-ko-note">{t("ko.orderOnly")} · {t("mc.ko.useNote")}</span>
        <span className="mc-ko-stamp">
          {data.season} · {t(`format.${format}`)} · {snapshot}
          {data.coverage.reusedFrom && (
            <> · {t("mc.ko.reusedFrom").replace("{season}", data.coverage.reusedFrom.season)}</>
          )}
          {data.coverage.moveShareCapturedAt && (
            <> · {t("mc.ko.movesAt").replace("{time}", stampTime(data.coverage.moveShareCapturedAt))}</>
          )}
        </span>
      </header>
      <div className="mc-ko-sides">
        <KoSide ko={data} side="koTargets" trend={trend} format={format} onPreviewOpen={onPreviewOpen} />
        <KoSide ko={data} side="koedBy" trend={trend} format={format} onPreviewOpen={onPreviewOpen} />
      </div>
    </section>
  );
}
