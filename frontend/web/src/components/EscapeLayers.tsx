/** One Escape handler in the shell. Layer priority reflects visual containment; opening order
 * resolves peers. A child input that consumes Escape never reaches this listener. */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

type Layer = { priority: number; close: () => void };
const layers: Layer[] = [];
const Scope = createContext(0);
export function EscapeLayerScope({ children }: { children: ReactNode }) {
  const parent = useContext(Scope);
  return <Scope.Provider value={parent + 100}>{children}</Scope.Provider>;
}
export function useEscapeLayer(open: boolean, close: () => void, priority = 20): void {
  const scope = useContext(Scope);
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const layer = { priority: scope + priority, close: () => latest.current() };
    layers.push(layer);
    return () => { const index = layers.indexOf(layer); if (index >= 0) layers.splice(index, 1); };
  }, [open, priority, scope]);
}

export function EscapeLayers() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const top = layers.reduce<Layer | null>((top, layer) => !top || layer.priority >= top.priority ? layer : top, null);
      if (!top) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      top.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
