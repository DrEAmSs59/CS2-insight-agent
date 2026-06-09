import { useState } from "react";
import { Download, Check, Ban, Loader2 } from "lucide-react";
import { useT } from "../../i18n/useT.js";

function fmtBytes(bytes) {
  if (!bytes) return "";
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function fmtExpiry(expiresAt, t) {
  if (!expiresAt) return "";
  const diff = new Date(expiresAt) - Date.now();
  if (diff <= 0) return t("match.demoExpired");
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return t("match.demoExpiryRemaining", { days, hours });
}

export default function DemoDownloadCell({
  matchId,
  demoUrl,
  demoExpired,
  demoInLibrary,
  demoExpiresAt,
  demoSizeBytes,
  filename,
  onDownload,
  onGoToLibrary,
}) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  if (demoExpired) {
    return (
      <div className="flex flex-col items-center gap-1">
        <button
          disabled
          className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border bg-transparent px-3 py-1.5 text-[12px] text-cs2-text-muted opacity-50 cursor-not-allowed"
        >
          <Ban className="h-3.5 w-3.5" />
          {t("match.demoExpired")}
        </button>
        <span className="font-mono text-[10px] text-cs2-text-muted">{t("match.demoExpiredHint")}</span>
      </div>
    );
  }

  if (demoInLibrary) {
    return (
      <div className="flex flex-col items-center gap-1">
        <button
          onClick={onGoToLibrary}
          className="flex items-center gap-1.5 rounded-[7px] border border-[#2eb86a]/40 bg-[#2eb86a]/10 px-3 py-1.5 text-[12px] font-semibold text-[#2eb86a] transition-colors hover:bg-[#2eb86a]/20"
        >
          <Check className="h-3.5 w-3.5" />
          {t("match.demoInLibrary")}
        </button>
        <span className="font-mono text-[10px] text-cs2-text-muted">{t("match.demoInLibraryHint")}</span>
      </div>
    );
  }

  async function handleDownload() {
    setLoading(true);
    setErr("");
    try {
      await onDownload(demoUrl, matchId, filename);
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || t("match.demoDownloadFail"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={handleDownload}
        disabled={loading}
        className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border bg-transparent px-3 py-1.5 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:border-cs2-accent hover:text-cs2-accent disabled:opacity-50"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {loading ? t("match.demoDownloading") : t("match.demoDownload")}
      </button>
      <span className="font-mono text-[10px] text-cs2-text-muted">
        {fmtBytes(demoSizeBytes)}{demoSizeBytes && demoExpiresAt ? " · " : ""}{fmtExpiry(demoExpiresAt, t)}
      </span>
      {err && <span className="text-[10px] text-cs2-fail">{err}</span>}
    </div>
  );
}
