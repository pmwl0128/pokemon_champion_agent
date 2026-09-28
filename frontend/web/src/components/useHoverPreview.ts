import { useRef, useState } from "react";
import { useEscapeLayer } from "./EscapeLayers.tsx";

/** Build previews open with a mouse or keyboard focus; a touch selects the underlying control. */
export function useHoverPreview<T extends HTMLElement>() {
  const anchorRef = useRef<T | null>(null);
  const [open, setOpen] = useState(false);
  useEscapeLayer(open, () => setOpen(false), 60);
  return { anchorRef, open, handlers: {
    onPointerEnter: (event: React.PointerEvent) => { if (event.pointerType === "mouse") setOpen(true); },
    onPointerLeave: () => setOpen(false),
    onPointerDown: (event: React.PointerEvent) => { if (event.pointerType !== "mouse") setOpen(false); },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if ((event.target as HTMLElement).matches(":focus-visible")) setOpen(true);
    },
    onBlur: () => setOpen(false),
  } };
}
