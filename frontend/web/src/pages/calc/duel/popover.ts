/** The one dismissal rule every popover on the duel strip shares.
 *
 * A popover that only closes on its own button strands itself the moment you click past it, so a
 * press anywhere outside its wrapper closes it, and so does Escape — which also hands focus back to
 * the control that opened it, or a keyboard user is left on a node that no longer exists. Tabbing
 * out closes it too; a click on the popover's own non-focusable text does NOT (that blur has no
 * related target), which is why the blur test requires one. */
import {
  useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject,
} from "react";

/** `returnTo` names the control focus goes back to when the popover was opened from somewhere else
 * (a menu item that has since unmounted); by default it is the popover's own `trigger`. */
export function usePopover<T extends HTMLElement = HTMLDivElement>(
  returnTo?: RefObject<HTMLButtonElement | null>,
) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<T>(null);
  const ownTrigger = useRef<HTMLButtonElement>(null);
  const trigger = returnTo ?? ownTrigger;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const onBlur = useCallback((event: FocusEvent<T>) => {
    const next = event.relatedTarget as Node | null;
    if (next && !event.currentTarget.contains(next)) setOpen(false);
  }, []);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return { open, setOpen, toggle, wrap, trigger, onBlur };
}

/** Moves focus to the first match inside `root` once it has rendered — the selected option of a
 * listbox, the first item of a menu — so arrow keys work the moment it opens. Programmatic focus
 * after a mouse click draws no focus ring, so pointer users see nothing change. */
export function useFocusOnOpen(open: boolean, root: { current: HTMLElement | null }, selector: string) {
  useEffect(() => {
    if (!open) return;
    const node = root.current;
    const target = node?.querySelector<HTMLElement>(selector)
      ?? node?.querySelector<HTMLElement>("button:not(:disabled)");
    target?.focus();
  }, [open, root, selector]);
}

const STEP: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/** Arrow / Home / End roving between the enabled matches of `selector`, for menus, listboxes and
 * toggle grids. It steps in DOM order and wraps: a grid with disabled cells has no geometry an
 * up/down jump could honour, and a linear walk never lands somewhere unexpected. */
export function roveFocus(event: KeyboardEvent<HTMLElement>, selector: string) {
  if (!(event.key in STEP) && event.key !== "Home" && event.key !== "End") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(selector))
    .filter((item) => !item.disabled);
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
      : at < 0 ? 0
        : (at + STEP[event.key]! + items.length) % items.length;
  items[next]!.focus();
}
