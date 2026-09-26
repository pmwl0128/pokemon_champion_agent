/** The one swap control the three roster tools share, sitting in the seam between their two cards —
 * the place the eye already reads as "these two, facing each other". It is the shared roster's own
 * swap, so pressing it on any tool swaps the same two teams, who is up, their moves and their side
 * conditions for every tool.
 *
 * The container opts in with `.swap-seam-host`; the control is placed between the two cards in the
 * DOM (so the tab order runs card → swap → card) and floats over the gap without taking space: the
 * cards keep exactly the layout they had. Side by side it points ⇄, stacked it turns to ⇅. */
import { useState } from "react";
import { useT } from "../../../i18n.ts";

export function SwapSeam({ onSwap }: { onSwap: () => void }) {
  const t = useT();
  // Each press turns the arrows half a turn further, so the motion always follows the click.
  const [turns, setTurns] = useState(0);
  return (
    <button type="button" className="swap-seam" aria-label={t("calc.swap")}
      aria-description={t("calc.flipAxisHint")}
      onClick={() => { setTurns((n) => n + 1); onSwap(); }}>
      <svg viewBox="0 0 20 20" aria-hidden style={{ ["--turns" as string]: turns }}>
        <path d="M3.5 7.25h12.5M12.75 4 16 7.25l-3.25 3.25M16.5 12.75H4M7.25 9.5 4 12.75 7.25 16"
          fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="swap-seam-label">{t("calc.swap")}</span>
    </button>
  );
}
