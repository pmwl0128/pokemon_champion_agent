/** A button with a one-line explanation of what it will do: shown as a tooltip on hover and keyboard
 * focus, and read by screen readers as the button's description. The description lives outside the
 * button so it never becomes part of the button's name. */
import { useId, type ButtonHTMLAttributes } from "react";

export function HintButton({ hint, className = "second-btn", children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { hint: string }) {
  const id = useId();
  return (
    <>
      <button type="button" {...rest} className={`${className} hint-tip`} data-tooltip={hint}
              aria-describedby={id}>
        {children}
      </button>
      <span id={id} className="sr-only">{hint}</span>
    </>
  );
}
