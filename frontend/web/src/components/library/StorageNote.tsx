/** The library as a whole, at the foot of the page: how much is open, whether the browser has
 * agreed to keep it through storage pressure and how much it uses, the file that backs it up or
 * carries it elsewhere, and that it belongs to this web address only (frontend/design.md §2.3 — the
 * page must say so, because a local app on another port or the online site shows a different,
 * possibly empty, library). */
import { IconDatabase, IconDownload, IconFileImport, IconShieldCheck } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { BOX_SLOTS } from "../../lib/library/records.ts";
import { storageStatus, type LibraryState, type StorageStatus } from "../../lib/library/repo.ts";
import { ImportDialog } from "./ImportDialog.tsx";
import { fill, useLibraryT } from "./messages.ts";
import { formatBytes, useExportAll } from "./shared.tsx";

export function StorageNote({ state }: { state: LibraryState | null }) {
  const t = useLibraryT();
  const exportAll = useExportAll();
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [importing, setImporting] = useState(false);
  // Usage is read again whenever the library changes size.
  const revision = state ? state.teams.length * 1000 + state.box.length : 0;

  useEffect(() => {
    let live = true;
    void storageStatus().then((next) => { if (live) setStatus(next); });
    return () => { live = false; };
  }, [revision]);

  return (
    <aside className="lib-store">
      <div className="lib-store-row">
        <span className="lib-store-status">
          {status?.persisted
            ? <><IconShieldCheck aria-hidden />{t("lib.store.persisted")}</>
            : <><IconDatabase aria-hidden />{t("lib.store.bestEffort")}</>}
          {status?.usage != null && (
            <span className="num muted">{fill(t("lib.store.usage"), { size: formatBytes(status.usage) })}</span>
          )}
        </span>
        <span className="lib-store-actions">
          <button type="button" className="second-btn lib-btn" onClick={() => setImporting(true)}>
            <IconFileImport aria-hidden />{t("lib.import")}
          </button>
          <button type="button" className="second-btn lib-btn" onClick={() => void exportAll()}>
            <IconDownload aria-hidden />{t("lib.exportAll")}
          </button>
        </span>
      </div>
      {state && (
        <p className="num">
          {fill(t("lib.store.capacity"), {
            boxes: state.layout.boxes.length, cells: state.layout.boxes.length * BOX_SLOTS,
            single: state.layout.teamSlots.single, double: state.layout.teamSlots.double,
          })}
        </p>
      )}
      <p>{t("lib.store.origin")}</p>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </aside>
  );
}
