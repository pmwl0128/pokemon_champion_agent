import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import { useLibraryFailure } from "../../lib/library/errors.ts";
import type { BoxRecord } from "../../lib/library/records.ts";
import { removeBoxRecord, restoreBoxRecord } from "../../lib/library/repo.ts";
import { useToast } from "../Toast.tsx";
import { fill, useLibraryT } from "./messages.ts";
import { speciesLabel } from "./shared.tsx";

/** Removing an individual also removes its team references; undo restores both as one write. */
export function useDeleteBoxRecord() {
  const t = useLibraryT(), toast = useToast(), failure = useLibraryFailure();
  const dex = useDexByName(), { lang } = useLang();
  return async (record: BoxRecord) => {
    try {
      const removed = await removeBoxRecord(record.id);
      if (!removed) return;
      const name = record.nickname || speciesLabel(record.member.species, dex, lang);
      toast({
        text: removed.memberships.length
          ? fill(t("lib.box.deletedFromTeams"), { name, n: removed.memberships.length })
          : fill(t("lib.toast.deleted"), { name }),
        action: { label: t("lib.toast.undo"), run: () => {
          void restoreBoxRecord(removed).then((ok) => {
            if (!ok) toast({ text: t("lib.toast.noCell") });
          }).catch((error: unknown) => toast({ text: failure(error) }));
        } },
      });
    } catch (error) { toast({ text: failure(error) }); }
  };
}
