import { useState } from "react";
import { Download, Check, Ban, Loader2 } from "lucide-react";

function fmtBytes(bytes) {
  if (!bytes) return "";
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function fmtExpiry(expiresAt) {
  if (!expiresAt) return "";
  const diff = new Date(expiresAt) - Date.now();
  if (diff <= 0) return "已过期";
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return `剩 ${days}d ${hours}h`;
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
          已过期
        </button>
        <span className="font-mono text-[10px] text-cs2-text-muted">超过 8 天保留</span>
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
          已入库
        </button>
        <span className="font-mono text-[10px] text-cs2-text-muted">跳转解析</span>
      </div>
    );
  }

  async function handleDownload() {
    setLoading(true);
    setErr("");
    try {
      await onDownload(demoUrl, matchId, filename);
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "下载失败");
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
        {loading ? "下载中…" : "下载"}
      </button>
      <span className="font-mono text-[10px] text-cs2-text-muted">
        {fmtBytes(demoSizeBytes)}{demoSizeBytes && demoExpiresAt ? " · " : ""}{fmtExpiry(demoExpiresAt)}
      </span>
      {err && <span className="text-[10px] text-cs2-fail">{err}</span>}
    </div>
  );
}
