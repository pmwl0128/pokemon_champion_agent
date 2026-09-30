import { IconBrandX, IconCopy, IconQrcode } from "@tabler/icons-react";
import { useT } from "../i18n.ts";
import { usePopover } from "../lib/popover.ts";
import { useToast } from "./Toast.tsx";
import qqCode from "../../../assets/community/qq-group-857634818.webp";

const QQ_GROUP = "857634818";
const QQ_INVITE = "https://qm.qq.com/q/YZjOlkaViK";

function QQCommunity() {
  const t = useT();
  const toast = useToast();
  const pop = usePopover();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(QQ_GROUP);
      toast({ text: t("footer.qqCopied") });
    } catch { toast({ text: t("footer.copyFailed") }); }
  };
  return (
    <div className="footer-qq" ref={pop.wrap} onBlur={pop.onBlur}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") pop.setOpen(true); }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && !event.currentTarget.contains(document.activeElement)) pop.setOpen(false);
      }}>
      <a href={QQ_INVITE} target="_blank" rel="noopener noreferrer" onFocus={() => pop.setOpen(true)}>
        {t("footer.qqGroup")} <span className="num">{QQ_GROUP}</span>
      </a>
      <button type="button" ref={pop.trigger} className="footer-qr-toggle" title={t("footer.qqScan")}
        aria-label={t("footer.qqScan")} aria-expanded={pop.open} aria-controls="footer-qq-code"
        onClick={pop.toggle}><IconQrcode aria-hidden /></button>
      {pop.open && (
        <div className="footer-qr-popover" id="footer-qq-code" role="group" aria-label={t("footer.qqScan")}>
          <strong>{t("footer.qqScan")}</strong>
          <div className="footer-qr-frame">
            <img src={qqCode} width="980" height="980" alt={t("footer.qqImageAlt")} decoding="async" />
          </div>
          <div className="footer-qr-caption">
            <span className="num">{QQ_GROUP}</span>
            <button type="button" onClick={() => void copy()}><IconCopy aria-hidden />{t("footer.qqCopy")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared, localized site furniture; no runtime-specific links or user data. */
export function SiteFooter() {
  const t = useT();
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-main">
          <span className="footer-copyright">© {new Date().getFullYear()} pmwl</span>
          <nav className="footer-community" aria-label={t("footer.community")}>
            <a href="https://x.com/pmwl007" target="_blank" rel="noopener noreferrer">
              <IconBrandX aria-hidden /><span>@pmwl007</span>
            </a>
            <QQCommunity />
          </nav>
        </div>
        <p className="footer-disclaimer">{t("footer.disclaimer")}</p>
      </div>
    </footer>
  );
}
