/** The top bar's way into the library dock, at its right end where the dock opens: a Poké Ball,
 * the same on every page whatever the library holds. */
import { IconPokeball, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n.ts";
import { useLibraryWorkspace } from "../lib/library/workspace.tsx";
import { useEscapeLayer } from "./EscapeLayers.tsx";

const DISCOVERY_KEY = "pcui-library-discovery:v1";
type Discovery = "new" | "hinted" | "opened";
let sessionDiscovery: Discovery = "new";
function readDiscovery(): Discovery {
  try {
    const saved = localStorage.getItem(DISCOVERY_KEY);
    return saved === "opened" || saved === "hinted" ? saved : sessionDiscovery;
  } catch { return sessionDiscovery; }
}
function saveDiscovery(value: Discovery) {
  sessionDiscovery = value;
  try { localStorage.setItem(DISCOVERY_KEY, value); } catch { /* Session-only fallback. */ }
}

export function LibraryDockButton({ preload }: { preload: () => void }) {
  const t = useT();
  const { open, setOpen } = useLibraryWorkspace("open", "setOpen");
  const [discovery, setDiscovery] = useState(readDiscovery);
  const [hint, setHint] = useState(false);
  const [pulse, setPulse] = useState(false);
  const discovered = discovery === "opened";
  useEffect(() => {
    if (discovered || open) return;
    const timer = setTimeout(() => {
      if (readDiscovery() !== "opened") setPulse(true);
    }, 800);
    return () => clearTimeout(timer);
  }, [discovered, open]);
  useEffect(() => {
    if (discovery !== "new" || open) return;
    const timer = setTimeout(() => {
      const current = readDiscovery();
      if (current === "new") {
        saveDiscovery("hinted");
        setDiscovery("hinted");
        setHint(true);
      } else setDiscovery(current);
    }, 800);
    return () => clearTimeout(timer);
  }, [discovery, open]);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), 8000);
    return () => clearTimeout(timer);
  }, [hint]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== DISCOVERY_KEY) return;
      setDiscovery(readDiscovery());
      setHint(false);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEscapeLayer(hint, () => setHint(false), 5);
  const toggle = () => {
    saveDiscovery("opened");
    setDiscovery("opened");
    setHint(false);
    setPulse(false);
    setOpen(!open);
  };
  return (
    <div className="library-entry">
      <button type="button" className={`topbar-tool dock-toggle${open ? " on" : ""}${discovery !== "opened" ? " discovering" : ""}`}
        aria-expanded={open} aria-controls="library-dock" title={t("library.entry")}
        aria-label={t("library.open")} aria-describedby={hint ? "library-discovery-hint" : undefined}
        onClick={toggle} onPointerEnter={preload} onFocus={preload}>
        <IconPokeball aria-hidden />
        {pulse && !discovered && <span className="library-discovery-ring" aria-hidden
          onAnimationEnd={() => setPulse(false)} />}
        {discovery !== "opened" && <span className="library-discovery-dot" aria-hidden />}
      </button>
      {hint && (
        <div className="library-discovery-hint" id="library-discovery-hint" role="status">
          <div><strong>{t("library.discoveryTitle")}</strong><p>{t("library.discoveryBody")}</p></div>
          <button type="button" title={t("library.dismissHint")} aria-label={t("library.dismissHint")}
            onClick={() => setHint(false)}><IconX aria-hidden /></button>
        </div>
      )}
    </div>
  );
}
