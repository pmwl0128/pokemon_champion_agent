/** Save the metagame cards as a picture, entirely in the browser.
 *
 * The dialog renders the SAME card components into a fixed-size frame (16:9 or 3:4), so the image
 * always has the desktop layout even when it is made on a phone: the cards lay out by their own
 * width (container queries), not by the viewport. The frame carries its own `data-theme`, so the
 * picture's theme is chosen here independently of the page.
 *
 * The picture holds no controls: the cards are passed in without their callbacks, and every image
 * inside is loaded eagerly and waited for before the capture. This chunk — and the screenshot
 * library with it — loads only when the dialog is opened. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EagerImages } from "../../components/GameImage.tsx";
import { Modal } from "../../components/Modal.tsx";
import { SegmentedControl } from "../../components/SegmentedControl.tsx";
import { useT } from "../../i18n.ts";
import { saveBlob } from "../../lib/download.ts";

type Content = "usage" | "ko" | "both";
type Ratio = "wide" | "tall";
type Theme = "light" | "dark";

/** CSS size of the frame; the capture multiplies it by PIXEL_RATIO (1600×900 -> 1920×1080). */
const FRAMES: Record<Ratio, { width: number; height: number }> = {
  wide: { width: 1600, height: 900 },
  tall: { width: 1200, height: 1600 },
};
const PIXEL_RATIO = 1.2;
const FRAME_PADDING = 44;

/** Wait until fonts and every image in the frame are final: a pending sprite would be captured as
 * its placeholder, a pending web font as the fallback face. */
async function settle(root: HTMLElement): Promise<void> {
  await document.fonts?.ready;
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const images = Array.from(root.querySelectorAll("img"));
    if (!root.querySelector("[data-img-pending]") && images.every((img) => img.complete)) break;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export default function ShareDialog({ usage, ko, fileBase, snapshot, onClose }: {
  usage: ReactNode;
  /** Null while the KO snapshot is missing: the dialog then offers the usage card only. */
  ko: ReactNode | null;
  fileBase: string;
  /** "season · rule · data date": the page shows it in its top bar, the picture in its frame. */
  snapshot: string;
  onClose: () => void;
}) {
  const t = useT();
  const [content, setContent] = useState<Content>("usage");
  const [theme, setTheme] = useState<Theme>(
    () => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [ratio, setRatio] = useState<Ratio>("wide");
  const [status, setStatus] = useState<"idle" | "working" | "copied" | "saved" | "copyFailed" | "failed">("idle");
  const [fit, setFit] = useState(1);
  const [view, setView] = useState(0.5);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const frame = FRAMES[ratio];
  const shown: Content = ko ? content : "usage";

  // Scale the cards to fill the frame. Their natural size is layout size, which a transform does
  // not change, so measuring the transformed element is stable.
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const measure = () => {
      if (!node.offsetWidth || !node.offsetHeight) return;
      setFit(Math.min((frame.width - 2 * FRAME_PADDING) / node.offsetWidth,
                      (frame.height - 2 * FRAME_PADDING) / node.offsetHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [frame.width, frame.height, shown]);

  // Scale the whole frame down to the dialog for the preview.
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setView(Math.min(1, node.clientWidth / frame.width,
      Math.max(200, window.innerHeight - 260) / frame.height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [frame.width, frame.height]);

  useEffect(() => { setStatus("idle"); }, [shown, theme, ratio]);

  const capture = async (): Promise<Blob> => {
    const node = frameRef.current;
    if (!node) throw new Error("share frame is not mounted");
    const { domToBlob } = await import("modern-screenshot");
    await settle(node);
    return domToBlob(node, {
      width: frame.width, height: frame.height, scale: PIXEL_RATIO, type: "image/png",
    });
  };

  const download = async () => {
    setStatus("working");
    try {
      saveBlob(await capture(), `${fileBase}_${shown}.png`);
      setStatus("saved");
    } catch (error) {
      console.error("Share image failed:", error);
      setStatus("failed");
    }
  };

  const copy = async () => {
    setStatus("working");
    try {
      // The item is created synchronously inside the click with a PROMISE of the blob: Safari
      // rejects a clipboard write that starts after an await.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": capture() })]);
      setStatus("copied");
    } catch (error) {
      console.error("Share copy failed:", error);
      setStatus("copyFailed");
    }
  };

  const contentItems = [
    { id: "usage" as const, label: t("share.usage") },
    ...(ko ? [{ id: "ko" as const, label: t("share.ko") }, { id: "both" as const, label: t("share.both") }] : []),
  ];
  const message = status === "working" ? t("share.working")
    : status === "copied" ? t("share.copied")
      : status === "saved" ? t("share.saved")
        : status === "copyFailed" ? t("share.copyFailed")
          : status === "failed" ? t("share.failed") : "";

  return (
    <Modal title={t("share.title")} onClose={onClose} width={1040} className="mc-share"
      footer={
        <>
          <span className="mc-share-size">
            {`${Math.round(frame.width * PIXEL_RATIO)}×${Math.round(frame.height * PIXEL_RATIO)} PNG`}
          </span>
          <span className="mc-share-status" role="status">{message}</span>
          <button type="button" className="second-btn" onClick={copy}
                  disabled={status === "working"}>{t("share.copy")}</button>
          <button type="button" className="primary-btn" onClick={download}
                  disabled={status === "working"}>{t("share.download")}</button>
        </>
      }>
        <div className="mc-share-options">
          <div className="mc-share-opt"><span>{t("share.content")}</span>
            <SegmentedControl kind="radio" className="mc-share-seg" ariaLabel={t("share.content")}
              items={contentItems} value={shown} onChange={setContent} /></div>
          <div className="mc-share-opt"><span>{t("share.theme")}</span>
            <SegmentedControl kind="radio" className="mc-share-seg" ariaLabel={t("share.theme")}
              items={[{ id: "light", label: t("share.light") }, { id: "dark", label: t("share.dark") }]}
              value={theme} onChange={setTheme} /></div>
          <div className="mc-share-opt"><span>{t("share.ratio")}</span>
            <SegmentedControl kind="radio" className="mc-share-seg" ariaLabel={t("share.ratio")}
              items={[{ id: "wide", label: t("share.wide") }, { id: "tall", label: t("share.tall") }]}
              value={ratio} onChange={setRatio} /></div>
        </div>
        <div className="mc-share-stage" ref={stageRef}>
        <div className="mc-share-preview"
             style={{ width: frame.width * view, height: frame.height * view }}>
          <div className="mc-share-scale"
               style={{ width: frame.width, height: frame.height, transform: `scale(${view})` }}>
            <div ref={frameRef} className="mc-share-frame" data-theme={theme}
                 style={{ width: frame.width, height: frame.height }}>
              <EagerImages.Provider value={true}>
                <div ref={contentRef} className="mc-share-content"
                     style={{ transform: `translate(-50%, -50%) scale(${fit})` }}>
                  {shown !== "ko" && usage}
                  {shown !== "usage" && ko}
                </div>
                {snapshot && <span className="mc-share-snap">{snapshot}</span>}
              </EagerImages.Provider>
            </div>
          </div>
        </div>
        </div>
    </Modal>
  );
}
