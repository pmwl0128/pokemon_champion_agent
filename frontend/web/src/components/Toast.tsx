/** Short-lived confirmations at the bottom of the screen: "saved", "deleted — undo".
 *
 * A toast never carries the only way to do something: an undo here is a convenience next to an
 * action the reader already took, not a step they must catch in time. Messages arrive already
 * translated; the region is a polite live region, so screen readers hear them without losing
 * their place. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export interface ToastInput {
  text: string;
  action?: { label: string; run: () => void };
}

interface ToastItem extends ToastInput {
  id: number;
}

const VISIBLE = 3;
const PLAIN_MS = 3500;
/** A toast with an action stays longer: reading "deleted" and reaching for "undo" takes time. */
const ACTION_MS = 7000;

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const serial = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback((toast: ToastInput) => {
    const id = ++serial.current;
    setItems((list) => [...list, { ...toast, id }].slice(-VISIBLE));
    timers.current.set(id, setTimeout(() => dismiss(id), toast.action ? ACTION_MS : PLAIN_MS));
  }, [dismiss]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className="toast">
            <span>{item.text}</span>
            {item.action && (
              <button type="button" onClick={() => { item.action!.run(); dismiss(item.id); }}>
                {item.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext);
}
