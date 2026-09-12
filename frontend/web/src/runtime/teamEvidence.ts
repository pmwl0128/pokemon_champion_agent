/** Only team-derived views have this clock; dex, meta and engine snapshots are unaffected. */
export async function loadTeamEvidence(
  load: (native: boolean) => Promise<unknown>, now: () => number = Date.now,
): Promise<unknown> {
  const mixed = await load(false) as { teamEvidenceExpiresAt?: string };
  if (mixed.teamEvidenceExpiresAt === undefined) return mixed;
  const expiry = Date.parse(mixed.teamEvidenceExpiresAt);
  if (!Number.isFinite(expiry)) throw new Error("Invalid team evidence expiry");
  if (now() < expiry) return mixed;
  const native = await load(true) as { teamEvidenceExpiresAt?: string };
  if (native.teamEvidenceExpiresAt !== undefined) throw new Error("Native team data contains handover evidence");
  return native;
}

type Watch = { listeners: Set<() => void>; timer: ReturnType<typeof setTimeout> };
const watches = new Map<number, Watch>();
function expire(): void {
  for (const [deadline, watch] of watches) {
    if (Date.now() < deadline) continue;
    watches.delete(deadline);
    clearTimeout(watch.timer);
    for (const listener of [...watch.listeners]) listener();
  }
  if (!watches.size) document.removeEventListener("visibilitychange", expire);
}

/** One timer per deadline and one visibility listener for all mounted team views. */
export function watchTeamExpiry(deadline: number, listener: () => void): () => void {
  let watch = watches.get(deadline);
  if (!watch) {
    if (!watches.size) document.addEventListener("visibilitychange", expire);
    watch = { listeners: new Set(), timer: setTimeout(expire, Math.max(0, deadline - Date.now())) };
    watches.set(deadline, watch);
  }
  watch.listeners.add(listener);
  return () => {
    watch.listeners.delete(listener);
    if (!watch.listeners.size) {
      clearTimeout(watch.timer);
      if (watches.get(deadline) === watch) watches.delete(deadline);
      if (!watches.size) document.removeEventListener("visibilitychange", expire);
    }
  };
}
