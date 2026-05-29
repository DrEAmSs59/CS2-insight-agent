import API from "../api/api";

/**
 * Export a batch of demos as RivalHub zips.
 * Calls onUpdate(demoId, status) where status is:
 *   { phase: "pending" | "loading" | "done" | "error", blob?: Blob, filename?: string, error?: string }
 *
 * @param {number[]} demoIds
 * @param {(id: number, status: object) => void} onUpdate
 * @param {number} [concurrency=2]
 */
export async function exportRivalHubBatch(demoIds, onUpdate, concurrency = 2) {
  const queue = [...demoIds];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id == null) break;
      onUpdate(id, { phase: "loading" });
      try {
        const response = await API.post(
          `/demos/${id}/export-rivalhub`,
          {},
          { responseType: "blob" }
        );
        const blob = new Blob([response.data], { type: "application/zip" });
        const disposition = response.headers?.["content-disposition"] || "";
        const match = disposition.match(/filename="?([^";\n]+)"?/i);
        const filename = match?.[1] || `rivalhub-demo-${id}.zip`;
        onUpdate(id, { phase: "done", blob, filename });
      } catch (err) {
        const msg =
          err?.response?.data instanceof Blob
            ? await err.response.data.text().then((t) => {
                try { return JSON.parse(t).detail; } catch { return t; }
              })
            : err?.response?.data?.detail || err?.message || "导出失败";
        onUpdate(id, { phase: "error", error: String(msg) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
}

/**
 * Trigger browser download for a Blob.
 * Returns a cleanup function to release the object URL.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return () => URL.revokeObjectURL(url);
}
