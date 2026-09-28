/** The site's one modal dialog. A backdrop and a titled panel; focus moves into the panel on open,
 * stays inside it while tabbing, and returns to where it was on close; Escape and a click on the
 * backdrop close it. Pages supply the body and the footer — nothing here knows what the dialog is
 * for. */
import { useLayoutEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n.ts";
import { EscapeLayerScope, useEscapeLayer } from "./EscapeLayers.tsx";

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), "
  + "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function Modal({ title, onClose, children, footer, width = 560, className }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Upper bound in CSS px; the panel never exceeds the viewport. */
  width?: number;
  className?: string;
}) {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousRef = useRef(document.activeElement as HTMLElement | null);
  useEscapeLayer(true, onClose, 100);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const focus = () => {
      const first = panel?.querySelector<HTMLElement>("[data-autofocus]")
        ?? panel?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea:not([disabled])")
        ?? panel?.querySelector<HTMLElement>(".modal-close");
      (first ?? panel)?.focus({ preventScroll: true });
    };
    focus();
    const keepFocus = (event: FocusEvent) => {
      if (!panel?.isConnected || panel.contains(event.target as Node)) return;
      const dialogs = document.querySelectorAll(".modal");
      if (dialogs[dialogs.length - 1] === panel) focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      const previous = previousRef.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((node) => node.offsetParent !== null);
    if (!nodes.length) { event.preventDefault(); return; }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <EscapeLayerScope><div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={panelRef} className={`modal${className ? ` ${className}` : ""}`} role="dialog"
           aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trapTab}
           style={{ width: `min(${width}px, 100%)` }}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-close" aria-label={t("common.close")}
                  onClick={onClose}>×</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div></EscapeLayerScope>,
    document.body,
  );
}
