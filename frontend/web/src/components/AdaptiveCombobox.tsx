import {
  Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type InputHTMLAttributes, type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

export interface ComboboxOption {
  key: string;
  value: string;
  secondary?: string;
  searchText?: string;
  /** Leads the list: the metagame's own picks for this Pokémon, set off from the rest by a rule. */
  group?: "meta";
  /** A short figure beside the option (its usage share). */
  badge?: string;
}

export type ComboboxCommitReason = "selection" | "enter" | "blur";

interface AdaptiveComboboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "list"
> {
  value: string;
  options: ComboboxOption[];
  onValueChange: (value: string) => void;
  onCommit?: (value: string, reason: ComboboxCommitReason) => void;
  /** Reuse a page-level datalist on desktop instead of duplicating a large option set. */
  nativeListId?: string;
  /** The styled list on every screen instead of the desktop datalist, which can neither group nor
   * mark options. It opens with the whole list, in order, and filters once the reader types. */
  listbox?: boolean;
}

function useMobileCombobox(): boolean {
  const query = "(max-width: 900px), (pointer: coarse)";
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return matches;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function AdaptiveCombobox({
  value, options, onValueChange, onCommit, nativeListId, listbox = false, disabled,
  onFocus, onKeyDown, onClick, ...inputProps
}: AdaptiveComboboxProps) {
  const mobile = useMobileCombobox();
  const custom = mobile || listbox;
  const reactId = useId().replace(/:/g, "");
  const listId = nativeListId ?? `adaptive-list-${reactId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Null until measured against the input: an unplaced list would paint one frame at the corner.
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  // Whether the reader has typed since the list opened. Until then the text is the current value,
  // and a list filtered by it would show only that value.
  const [typed, setTyped] = useState(false);

  const filtered = useMemo(() => {
    if (listbox && !typed) return options;
    const needle = normalized(value);
    const hits = needle
      ? options.filter((option) => normalized(
        `${option.value} ${option.secondary ?? ""} ${option.searchText ?? ""}`,
      ).includes(needle))
      : options;
    return hits.slice(0, listbox ? 120 : 60);
  }, [options, value, listbox, typed]);

  const place = () => {
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;
    const below = viewportBottom - rect.bottom - 8;
    const above = rect.top - viewportTop - 8;
    const useAbove = below < 180 && above > below;
    const maxHeight = Math.max(120, Math.min(300, useAbove ? above : below));
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setPlacement({
      left,
      top: useAbove ? rect.top - maxHeight - 6 : rect.bottom + 6,
      width,
      maxHeight,
    });
  };

  // Placed before paint, so the list first appears where it belongs.
  useLayoutEffect(() => {
    if (!custom || !open) { setPlacement(null); return; }
    place();
    const update = () => place();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [custom, open]);

  useEffect(() => setActive(0), [value]);
  // Keyboard moves keep the active option in view.
  useEffect(() => {
    if (!custom || !open) return;
    document.getElementById(`${listId}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [custom, open, active, listId]);

  const openList = () => {
    setTyped(false);
    setActive(0);
    setOpen(true);
  };

  const select = (option: ComboboxOption) => {
    onValueChange(option.value);
    onCommit?.(option.value, "selection");
    setOpen(false);
    inputRef.current?.focus();
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (custom && event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + (open ? 1 : 0), filtered.length - 1));
    } else if (custom && event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.max(0, current - 1));
    } else if (custom && event.key === "Enter" && open && filtered[active]) {
      event.preventDefault();
      select(filtered[active]);
    } else if (custom && event.key === "Escape" && open) {
      // Closes the list only — not the dialog the input may sit in.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Enter") {
      onCommit?.(value, "enter");
    }
    onKeyDown?.(event);
  };

  const input = (
    <input
      {...inputProps}
      ref={inputRef}
      value={value}
      disabled={disabled}
      list={!custom && !disabled ? listId : undefined}
      autoComplete={inputProps.autoComplete ?? "off"}
      role={custom ? "combobox" : inputProps.role}
      aria-autocomplete={custom ? "list" : undefined}
      aria-expanded={custom ? open && filtered.length > 0 : undefined}
      aria-controls={custom ? listId : undefined}
      aria-activedescendant={custom && open && filtered[active]
        ? `${listId}-option-${active}` : undefined}
      onChange={(event) => {
        onValueChange(event.target.value);
        setTyped(true);
        if (custom) setOpen(true);
      }}
      onFocus={(event) => {
        if (custom && !disabled) openList();
        onFocus?.(event);
      }}
      onClick={(event) => {
        // Reopens a list closed with Escape while the input kept focus.
        if (custom && !disabled && !open) openList();
        onClick?.(event);
      }}
      onBlur={() => {
        onCommit?.(value, "blur");
        setOpen(false);
      }}
      onKeyDown={handleKey}
    />
  );

  return (
    <>
      {input}
      {!custom && !nativeListId && (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option.key} value={option.value}>{option.secondary ?? ""}</option>
          ))}
        </datalist>
      )}
      {custom && open && filtered.length > 0 && createPortal(
        <div
          id={listId}
          role="listbox"
          className={`adaptive-listbox${listbox ? " rich" : ""}`}
          style={placement ? {
            left: placement.left, top: placement.top, width: placement.width,
            maxHeight: placement.maxHeight,
          } : { visibility: "hidden" }}
        >
          {filtered.map((option, index) => (
            <Fragment key={option.key}>
              {index > 0 && option.group !== "meta" && filtered[index - 1]!.group === "meta" && (
                <div className="adaptive-sep" role="separator" />
              )}
              <button
                id={`${listId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`${index === active ? "active" : ""}${option.group === "meta" ? " meta" : ""}`}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(index)}
                onClick={() => select(option)}
              >
                <span>{option.value}</span>
                {option.secondary && option.secondary !== option.value && (
                  <small>{option.secondary}</small>
                )}
                {option.badge && <b className="adaptive-share">{option.badge}</b>}
              </button>
            </Fragment>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
