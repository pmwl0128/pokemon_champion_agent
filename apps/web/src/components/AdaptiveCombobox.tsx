import {
  useEffect, useId, useMemo, useRef, useState,
  type InputHTMLAttributes, type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

export interface ComboboxOption {
  key: string;
  value: string;
  secondary?: string;
  searchText?: string;
}

interface AdaptiveComboboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "list"
> {
  value: string;
  options: ComboboxOption[];
  onValueChange: (value: string) => void;
  onCommit?: (value: string) => void;
  /** Reuse a page-level datalist on desktop instead of duplicating a large option set. */
  nativeListId?: string;
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
  value, options, onValueChange, onCommit, nativeListId, disabled,
  onFocus, onKeyDown, ...inputProps
}: AdaptiveComboboxProps) {
  const mobile = useMobileCombobox();
  const reactId = useId().replace(/:/g, "");
  const listId = nativeListId ?? `adaptive-list-${reactId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState({ left: 8, top: 8, width: 240, maxHeight: 280 });

  const filtered = useMemo(() => {
    const needle = normalized(value);
    const hits = needle
      ? options.filter((option) => normalized(
        `${option.value} ${option.secondary ?? ""} ${option.searchText ?? ""}`,
      ).includes(needle))
      : options;
    return hits.slice(0, 60);
  }, [options, value]);

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

  useEffect(() => {
    if (!mobile || !open) return;
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
  }, [mobile, open]);

  useEffect(() => setActive(0), [value]);

  const select = (option: ComboboxOption) => {
    onValueChange(option.value);
    onCommit?.(option.value);
    setOpen(false);
    inputRef.current?.focus();
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (mobile && event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + (open ? 1 : 0), filtered.length - 1));
    } else if (mobile && event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.max(0, current - 1));
    } else if (mobile && event.key === "Enter" && open && filtered[active]) {
      event.preventDefault();
      select(filtered[active]);
    } else if (mobile && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Enter") {
      onCommit?.(value);
    }
    onKeyDown?.(event);
  };

  const input = (
    <input
      {...inputProps}
      ref={inputRef}
      value={value}
      disabled={disabled}
      list={!mobile && !disabled ? listId : undefined}
      autoComplete={mobile ? "off" : inputProps.autoComplete}
      role={mobile ? "combobox" : inputProps.role}
      aria-autocomplete={mobile ? "list" : undefined}
      aria-expanded={mobile ? open && filtered.length > 0 : undefined}
      aria-controls={mobile ? listId : undefined}
      aria-activedescendant={mobile && open && filtered[active]
        ? `${listId}-option-${active}` : undefined}
      onChange={(event) => {
        onValueChange(event.target.value);
        if (mobile) setOpen(true);
      }}
      onFocus={(event) => {
        if (mobile && !disabled) setOpen(true);
        onFocus?.(event);
      }}
      onBlur={() => {
        onCommit?.(value);
        setOpen(false);
      }}
      onKeyDown={handleKey}
    />
  );

  return (
    <>
      {input}
      {!mobile && !nativeListId && (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option.key} value={option.value}>{option.secondary ?? ""}</option>
          ))}
        </datalist>
      )}
      {mobile && open && filtered.length > 0 && createPortal(
        <div
          id={listId}
          role="listbox"
          className="adaptive-listbox"
          style={{
            left: placement.left, top: placement.top, width: placement.width,
            maxHeight: placement.maxHeight,
          }}
        >
          {filtered.map((option, index) => (
            <button
              key={option.key}
              id={`${listId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => select(option)}
            >
              <span>{option.value}</span>
              {option.secondary && option.secondary !== option.value && (
                <small>{option.secondary}</small>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
