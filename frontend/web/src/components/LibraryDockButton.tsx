/** The top bar's way into the library dock, at its right end where the dock opens: a Poké Ball,
 * the same on every page whatever the library holds. */
import { IconPokeball } from "@tabler/icons-react";
import { useT } from "../i18n.ts";
import { useLibraryWorkspace } from "../lib/library/workspace.tsx";

export function LibraryDockButton({ preload }: { preload: () => void }) {
  const t = useT();
  const { open, setOpen } = useLibraryWorkspace("open", "setOpen");
  const title = t("library.open");
  return (
    <button type="button" className={`topbar-tool dock-toggle${open ? " on" : ""}`}
            aria-expanded={open} aria-controls="library-dock" title={title} aria-label={title}
            onClick={() => setOpen(!open)} onPointerEnter={preload} onFocus={preload}>
      <IconPokeball aria-hidden />
    </button>
  );
}
