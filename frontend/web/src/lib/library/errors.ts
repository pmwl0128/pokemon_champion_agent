import { defineMessages } from "../../i18n.ts";

const useMessages = defineMessages({
  invalid: { zh: "配置格式无法读取，请检查宝可梦名称与字段后重试。", en: "The build could not be read. Check its names and fields, then retry.", ja: "型を読み取れません。名前と各項目を確認してください。" },
  quota: { zh: "浏览器存储空间不足。请先导出备份，再释放空间。", en: "Browser storage is full. Export a backup before freeing space.", ja: "ブラウザの保存容量が不足しています。先にバックアップを書き出してください。" },
  storage: { zh: "无法访问本地资料库，请检查浏览器的站点数据权限。", en: "The local library is unavailable. Check the browser's site data permissions.", ja: "ローカルデータにアクセスできません。サイトデータの権限を確認してください。" },
  failed: { zh: "操作未完成，请重试；原有资料仍保留。", en: "The operation did not finish. Retry; existing data is retained.", ja: "操作が完了しませんでした。既存のデータは保持されています。再試行してください。" },
});

export function useLibraryFailure() {
  const t = useMessages();
  return (error: unknown): string => {
    const name = error instanceof Error ? error.name : "";
    if (/QuotaExceeded/.test(name)) return t("quota");
    if (/ZodError|TypeError|DataError|RangeError/.test(name)) return t("invalid");
    if (/SecurityError|InvalidStateError|DatabaseClosedError|OpenFailedError/.test(name)) return t("storage");
    return t("failed");
  };
}
