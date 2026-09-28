/** Meta-detail page: one Pokemon's metagame facts in one format, as two cards that can each be
 * captured as a picture — the usage card (ranking/details clock) and the KO card (its own snapshot
 * clock). Reached from the ranking grid and from the dex page's rank chips. */
import type { FormatId } from "@pokemon-champions/protocol";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { MetaRail, useMetaRails } from "../components/MetaRails.tsx";
import { RailHandle } from "../components/SideRail.tsx";
import {
  useDetail, useDexByName, useKo, useKoTrend, useOppSets, usePokemonCard, useRanking,
  useUsageTrend,
} from "../hooks.ts";
import { displayName, useLang, useT } from "../i18n.ts";
import { realSetsFor } from "../lib/realSets.ts";
import { useTransferT } from "../lib/library/transferMessages.ts";
import { useLibrarySource } from "../lib/library/workspace.tsx";
import { toTeamMember } from "../lib/teamDoc.ts";
import { useRuntime } from "../runtime/context.tsx";
import { KoCard } from "./meta/KoCard.tsx";
import type { MetaForm } from "./meta/MetaHero.tsx";
import { UsageCard, type UsageCardProps } from "./meta/UsageCard.tsx";
import "../styles.meta.css";

const ShareDialog = lazy(() => import("./meta/ShareDialog.tsx"));

/** The host printed on the share image's brand line. A loopback or LAN-less address names nothing a
 * viewer of the picture could visit, so it is left out. */
function publicHost(): string | undefined {
  const host = window.location.hostname;
  return !host || host === "localhost" || host === "::1" || host === "[::1]"
    || /^127\./.test(host) || host === "0.0.0.0" ? undefined : host;
}

export function MetaPage() {
  const { slug: routeSlug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const format = (params.get("format") === "double" ? "double" : "single") as FormatId;
  const setFormat = (next: FormatId) => {
    const updated = new URLSearchParams(params);
    updated.set("format", next);
    setParams(updated, { replace: true });
  };
  const { capabilities } = useRuntime();
  const singleRanking = useRanking("single");
  const doubleRanking = useRanking("double");
  // The route may carry either identity: the upstream meta id (ranking links) or the dex slug
  // (teammate and KO tiles, whose rows are keyed by species). They differ for a few names
  // (`sirfetch-d` vs `sirfetchd`), so both resolve through the ranking row: metagame documents
  // are fetched by its meta `slug`, the dex card by its asset `key`. Until the rankings settle an
  // unmatched route requests nothing, rather than a document under the wrong name.
  const rankRows = [singleRanking, doubleRanking]
    .flatMap((r) => r.status === "ready" ? r.data.rows : []);
  const rankRow = rankRows.find((r) => r.slug === routeSlug)
    ?? rankRows.find((r) => r.key === `pokemon:${routeSlug}`);
  const settled = singleRanking.status !== "loading" && doubleRanking.status !== "loading";
  const slug = rankRow?.slug ?? (settled ? routeSlug : "");
  const dexSlug = rankRow?.key?.replace(/^pokemon:/, "") ?? (settled ? routeSlug : "");
  const card = usePokemonCard(dexSlug);
  const detail = useDetail(format, slug);
  // The usage history feeds the change column as well as the hover charts, so it loads with the
  // page; one document per Pokemon, shared by every row through the query cache.
  const usageTrend = useUsageTrend(format, slug, Boolean(slug));
  const ko = useKo(format, slug);
  // The KO axis keeps its own history document (its own capture clock), fetched only once a reader
  // actually opens one of those previews.
  const [koTrendWanted, setKoTrendWanted] = useState(false);
  const koTrend = useKoTrend(format, slug, koTrendWanted && Boolean(slug));
  const oppSets = useOppSets(format);
  const rails = useMetaRails();
  const [, setAllowed] = useState<Set<string> | null>(null);
  const dexByName = useDexByName();
  const { lang } = useLang();
  const t = useT();

  // Base/Mega identity toggle: usage is keyed by the BASE species, but a Mega team plays the Mega's
  // types and stats — the hero offers both and follows the selection; usage stays on the base.
  const [formIdx, setFormIdx] = useState(0);
  useEffect(() => { setFormIdx(0); }, [slug]);
  const megaList = card.status === "ready" ? card.data.megaForms ?? [] : [];
  const megaTarget = formIdx > 0 ? megaList[formIdx - 1]?.name ?? dexSlug : dexSlug;
  const megaCard = usePokemonCard(megaTarget);

  const [setIdx, setSetIdx] = useState(0);
  useEffect(() => { setSetIdx(0); }, [slug, format]);
  const [sharing, setSharing] = useState(false);

  const activeRanking = format === "single" ? singleRanking : doubleRanking;
  const usageRank = useMemo(() => new Map(
    activeRanking.status === "ready"
      ? activeRanking.data.rows.map((r) => [r.name, r.rank] as const) : []), [activeRanking]);
  const sets = useMemo(() => detail.status === "ready" && oppSets.status === "ready"
    ? realSetsFor(oppSets.data, detail.data.name) : [], [detail, oppSets]);

  // The library workspace (design §2.4): the build on screen can be kept in a box. It is stored
  // as the base species holding its stone, with the ability it has before Mega Evolving.
  const bt = useTransferT();
  const shownSet = sets[setIdx]?.set ?? null;
  useLibrarySource(shownSet ? { id: "meta-keep", origin: "meta", kind: "pokemon", label: bt("transfer.meta.save"),
    read: () => toTeamMember({
      species: shownSet.species, item: shownSet.item, nature: shownSet.nature,
      ability: shownSet.baseAbility ?? shownSet.ability, moves: shownSet.moves ?? [], spread: shownSet.sps,
    }) } : null);

  // The rail renders on EVERY branch, including the loading flash between two Pokemon. Putting it
  // only in the ready branch unmounted it on each navigation, which silently threw away the active
  // filter and the search text — the one piece of state a browsing rail must survive with.
  const rail = (
    <>
      <RailHandle state={rails} label={t("rail.search")} />
      <MetaRail state={rails} format={format} ranking={activeRanking} activeSlug={slug}
        onAllowed={setAllowed} />
    </>
  );
  if (card.status === "loading") {
    return <>{rail}<div className="spinner">{t("state.loading")}</div></>;
  }
  if (card.status === "error") {
    return <>{rail}<div className="notice">{t("state.errorDetail")}</div></>;
  }
  const base = card.data;
  const mon = formIdx > 0 && megaCard.status === "ready" && megaCard.data.slug !== base.slug
    ? megaCard.data : base;
  const rankOf = (r: typeof singleRanking) =>
    r.status === "ready" ? r.data.rows.find((row) => row.slug === slug)?.rank ?? null : null;
  const ranks: Array<[FormatId, number | null]> = [
    ["single", rankOf(singleRanking)], ["double", rankOf(doubleRanking)],
  ];
  const forms: MetaForm[] | undefined = megaList.length > 0 ? [
    { key: "base", label: displayName(base, lang), assetKey: base.key, active: formIdx === 0,
      onSelect: () => setFormIdx(0) },
    ...megaList.map((mf, i) => {
      const entry = dexByName.get(mf.name);
      return {
        key: mf.name, label: entry ? displayName(entry, lang) : mf.name,
        assetKey: entry?.key ?? base.key, active: formIdx === i + 1, onSelect: () => setFormIdx(i + 1),
      };
    }),
  ] : undefined;

  const env = detail.status === "ready" ? detail.data : capabilities.environment;
  const cardProps: UsageCardProps = {
    mon, forms, format, ranks, detail, trend: usageTrend, usageRank, sets,
    setIndex: setIdx,
  };
  // The page names the snapshot in its top bar; the share image has no top bar, so its frame does.
  const snapshot = [env.season, env.rule, capabilities.environment.asOf].filter(Boolean).join(" · ");
  const fileBase = [base.slug, format, env.season, capabilities.environment.asOf]
    .filter(Boolean).join("_");

  return (
    <>
      {rail}
      <div className="mc-page">
        <UsageCard {...cardProps} onFormat={setFormat} onSetIndex={setSetIdx}
                   onShare={() => setSharing(true)} />
        <KoCard ko={ko} trend={koTrend} format={format} onPreviewOpen={() => setKoTrendWanted(true)} />
      </div>
      {sharing && (
        <Suspense fallback={null}>
          <ShareDialog fileBase={fileBase} snapshot={snapshot} onClose={() => setSharing(false)}
            usage={<UsageCard {...cardProps} host={publicHost()} />}
            ko={ko.status === "ready" ? <KoCard ko={ko} trend={koTrend} format={format} /> : null} />
        </Suspense>
      )}
    </>
  );
}
