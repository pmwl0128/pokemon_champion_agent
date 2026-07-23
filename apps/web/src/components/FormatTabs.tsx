import type { FormatId } from "@pokemon-champions/protocol";
import { useT } from "../i18n.ts";
import { SegmentedControl } from "./SegmentedControl.tsx";

/** The single/double segmented control shared by the ranking, trend, and calc pages (was
 * copy-pasted verbatim in all three). */
export function FormatTabs({ format, onChange, className = "" }: {
  format: FormatId;
  onChange: (f: FormatId) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <SegmentedControl kind="radio" value={format} onChange={onChange}
      ariaLabel={t("a11y.format")} className={`seg${className ? ` ${className}` : ""}`}
      items={(["single", "double"] as const).map((id) => ({
        id,
        label: t(`format.${id}`),
      }))} />
  );
}
