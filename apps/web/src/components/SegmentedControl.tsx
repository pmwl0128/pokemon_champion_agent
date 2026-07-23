import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type SegmentedItem<T extends string> = {
  id: T;
  label: ReactNode;
};

type CommonProps<T extends string> = {
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  buttonClassName?: string;
};

type TabProps<T extends string> = CommonProps<T> & {
  kind: "tabs";
  idBase: string;
};

type RadioProps<T extends string> = CommonProps<T> & {
  kind: "radio";
  idBase?: never;
};

export function segmentedTabId(idBase: string, id: string): string {
  return `${idBase}-tab-${id}`;
}

export function segmentedPanelId(idBase: string, id: string): string {
  return `${idBase}-panel-${id}`;
}

/** Shared roving-focus control for page tabs and compact radio choices. Arrow keys move and
 * activate, Home/End jump to the edges, and only the current item participates in normal Tab
 * order. This keeps the visual primitive while giving it the expected keyboard contract. */
export function SegmentedControl<T extends string>(props: TabProps<T> | RadioProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const current = Math.max(0, props.items.findIndex((item) => item.id === props.value));

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const key = event.key;
    let next = index;
    if (key === "ArrowRight" || key === "ArrowDown") next = (index + 1) % props.items.length;
    else if (key === "ArrowLeft" || key === "ArrowUp") {
      next = (index - 1 + props.items.length) % props.items.length;
    } else if (key === "Home") next = 0;
    else if (key === "End") next = props.items.length - 1;
    else return;

    event.preventDefault();
    const item = props.items[next];
    if (!item) return;
    props.onChange(item.id);
    refs.current.get(item.id)?.focus();
  };

  return (
    <div className={props.className} role={props.kind === "tabs" ? "tablist" : "radiogroup"}
      aria-label={props.ariaLabel} aria-orientation="horizontal">
      {props.items.map((item, index) => {
        const selected = index === current;
        return (
          <button key={item.id} type="button"
            ref={(node) => {
              if (node) refs.current.set(item.id, node);
              else refs.current.delete(item.id);
            }}
            role={props.kind === "tabs" ? "tab" : "radio"}
            id={props.kind === "tabs" ? segmentedTabId(props.idBase, item.id) : undefined}
            aria-controls={props.kind === "tabs" ? segmentedPanelId(props.idBase, item.id) : undefined}
            aria-selected={props.kind === "tabs" ? selected : undefined}
            aria-checked={props.kind === "radio" ? selected : undefined}
            tabIndex={selected ? 0 : -1}
            className={`${props.buttonClassName ?? ""}${selected ? " on" : ""}`.trim()}
            onKeyDown={(event) => move(event, index)}
            onClick={() => props.onChange(item.id)}>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
