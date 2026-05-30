import API from "../api/api";

/**
 * Export all selected demos as a single merged RivalHub zip.
 * Returns the Blob on success, or throws on error.
 *
 * @param {number[]} demoIds
 * @returns {Promise<{ blob: Blob, filename: string, exported: number, skipped: number[] }>}
 */
export async function exportRivalHubBatch(demoIds) {
  const response = await API.post(
    "/demos/export-rivalhub-batch",
    { demo_ids: demoIds },
    { responseType: "blob" }
  );

  const detailHeader = response.headers?.["x-export-detail"];
  let exported = 0;
  let skipped = [];
  if (detailHeader) {
    try {
      const detail = JSON.parse(detailHeader);
      exported = detail.exported ?? 0;
      skipped = detail.skipped ?? [];
    } catch { /* ignore */ }
  }

  return {
    blob: new Blob([response.data], { type: "application/zip" }),
    filename: "rivalhub-exports.zip",
    exported,
    skipped,
  };
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
