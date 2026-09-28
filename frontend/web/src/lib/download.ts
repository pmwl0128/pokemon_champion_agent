/** Hand a file to the reader's browser as a download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function saveJson(value: unknown, filename: string): void {
  saveBlob(new Blob([`${JSON.stringify(value, null, 1)}\n`], { type: "application/json" }), filename);
}

/** Plain text to the clipboard. The async API can be refused by browser policy; the temporary
 * textarea fallback still writes text/plain only. Resolves false when both paths fail. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}
