import { useCallback, useEffect, useState } from "react";
import { Archive, Download, History, Loader2, RefreshCw, RotateCcw, Trash2, X, Zap } from "lucide-react";
import API from "../../../api/api.js";

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const snapshotLabel = (reason) => ({ before_export: "导出前", before_restore: "恢复前", save: "保存" }[reason] || "快照");

export default function LiteCutManagementCenter({ open, onClose, projectId, onRestoreSnapshot, onImportPortable, onStartPortableExport }) {
  const [cache, setCache] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [resolution, setResolution] = useState(720);
  const [portableJob, setPortableJob] = useState(null);

  const refresh = useCallback(async () => {
    if (!open) return;
    setError("");
    try {
      const [cacheResult, snapshotsResult] = await Promise.all([
        API.get("/lite-cut/proxy-cache"),
        projectId ? API.get(`/lite-cut/projects/${projectId}/snapshots`) : Promise.resolve({ data: { items: [] } }),
      ]);
      setCache(cacheResult.data || null);
      setResolution(Number(cacheResult.data?.resolution) || 720);
      setSnapshots(snapshotsResult.data?.items || []);
    } catch {
      setError("读取管理信息失败，请稍后重试。");
    }
  }, [open, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!portableJob?.job_id || !["queued", "running", "cancelling"].includes(portableJob.status)) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const { data } = await API.get(`/lite-cut/portable-package/jobs/${portableJob.job_id}`);
        setPortableJob(data);
        if (!["queued", "running", "cancelling"].includes(data.status)) setBusy("");
      } catch {
        setPortableJob((current) => current ? { ...current, status: "error", error: "无法读取打包进度" } : current);
        setBusy("");
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [portableJob?.job_id, portableJob?.status]);

  const run = async (name, action) => {
    setBusy(name); setError("");
    try { await action(); await refresh(); } catch (err) { setError(err?.response?.data?.detail || "操作失败，请稍后重试。"); } finally { setBusy(""); }
  };

  const startPortableExport = async () => {
    if (!projectId) return;
    setBusy("portable-export"); setError(""); setPortableJob(null);
    try {
      const result = await onStartPortableExport?.();
      if (result?.cancelled) { setBusy(""); return; }
      setPortableJob(result?.data || result);
    } catch (err) {
      setError(err?.response?.data?.detail || "便携工程包启动失败，请稍后重试。");
      setBusy("");
    }
  };

  const cancelPortableExport = async () => {
    if (!portableJob?.job_id || !["queued", "running"].includes(portableJob.status)) return;
    try {
      const { data } = await API.delete(`/lite-cut/portable-package/jobs/${portableJob.job_id}`);
      setPortableJob(data);
    } catch (err) {
      setError(err?.response?.data?.detail || "取消打包失败，请稍后重试。");
    }
  };

  if (!open) return null;
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="LiteCut 工程管理">
    <section className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-cs2-border bg-cs2-bg-card shadow-2xl">
      <header className="flex items-center justify-between border-b border-cs2-border px-5 py-4">
        <div><h2 className="text-sm font-bold text-cs2-text-primary">工程与缓存管理</h2><p className="mt-1 text-[11px] text-cs2-text-muted">代理缓存、历史版本和跨电脑便携工程包</p></div>
        <div className="flex gap-1"><button type="button" title="刷新" onClick={() => void refresh()} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-cs2-text-muted hover:bg-white/5"><RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /></button><button type="button" title="关闭" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-cs2-text-muted hover:bg-white/5"><X className="h-4 w-4" /></button></div>
      </header>
      <div className="min-h-0 overflow-y-auto p-5">
        {error ? <p className="mb-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{String(error)}</p> : null}
        <section className="rounded-xl border border-cs2-border bg-cs2-surface-1/50 p-4">
          <div className="flex items-center gap-2"><Zap className="h-4 w-4 text-cs2-accent" /><h3 className="text-xs font-bold text-cs2-text-primary">代理与缓存</h3></div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["代理空间", formatBytes(cache?.proxy_bytes)], ["代理文件", cache?.proxy_files ?? "—"], ["可清理", formatBytes(cache?.orphan_bytes)], ["需代理素材", cache?.proxy_required_assets ?? "—"]].map(([label, value]) => <div key={label} className="rounded-lg bg-black/15 px-3 py-2"><p className="text-[10px] text-cs2-text-muted">{label}</p><p className="mt-0.5 text-sm font-bold text-cs2-text-primary">{value}</p></div>)}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[11px] text-cs2-text-secondary">预览最长边<select value={resolution} onChange={(e) => setResolution(Number(e.target.value))} className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1 text-xs text-cs2-text-primary"><option value={540}>540p</option><option value={720}>720p</option><option value={1080}>1080p</option><option value={1440}>1440p</option></select></label>
            <button type="button" disabled={busy} onClick={() => void run("settings", () => API.patch("/lite-cut/proxy-cache/settings", { resolution }))} className="rounded-md border border-cs2-border px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5 disabled:opacity-50">保存设置</button>
            <button type="button" disabled={busy} onClick={() => void run("regen", () => API.post("/lite-cut/proxy-cache/regenerate", {}))} className="rounded-md border border-cs2-accent/40 bg-cs2-accent-soft px-2.5 py-1.5 text-[11px] font-semibold text-cs2-accent disabled:opacity-50">{busy === "regen" ? "正在加入队列…" : "重新生成全部代理"}</button>
            <button type="button" disabled={busy || !(cache?.orphan_files > 0)} onClick={() => void run("cleanup", () => API.post("/lite-cut/proxy-cache/cleanup"))} className="rounded-md border border-cs2-border px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5 disabled:opacity-50"><Trash2 className="mr-1 inline h-3.5 w-3.5" />清理无用代理</button>
          </div>
        </section>
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-surface-1/50 p-4">
          <div className="flex items-center gap-2"><History className="h-4 w-4 text-sky-300" /><h3 className="text-xs font-bold text-cs2-text-primary">工程历史版本</h3><span className="text-[10px] text-cs2-text-muted">保留最近 50 个快照；导出前版本会单独标记</span></div>
          <div className="mt-3 max-h-52 overflow-y-auto rounded-lg border border-cs2-border-subtle">
            {snapshots.length ? snapshots.map((item) => <div key={item.id} className="flex items-center gap-3 border-b border-cs2-border-subtle px-3 py-2 last:border-0"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.reason === "before_export" ? "bg-amber-400/15 text-amber-200" : "bg-white/5 text-cs2-text-secondary"}`}>{snapshotLabel(item.reason)}</span><span className="min-w-0 flex-1 truncate text-[11px] text-cs2-text-secondary">{new Date(item.created_at).toLocaleString()}</span><button type="button" disabled={busy} onClick={() => void run(`restore-${item.id}`, async () => { await onRestoreSnapshot?.(item.id); })} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold text-sky-200 hover:bg-sky-400/10 disabled:opacity-50"><RotateCcw className="h-3 w-3" />恢复</button></div>) : <p className="px-3 py-5 text-center text-xs text-cs2-text-muted">保存工程或开始导出后，这里会出现可恢复的版本。</p>}
          </div>
        </section>
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-surface-1/50 p-4">
          <div className="flex items-center gap-2"><Archive className="h-4 w-4 text-emerald-300" /><h3 className="text-xs font-bold text-cs2-text-primary">便携工程包</h3></div>
          <p className="mt-2 text-[11px] leading-relaxed text-cs2-text-secondary">导出会收集当前工程的工程 JSON、视频、图片、字体和 BGM。导入后会自动重建素材引用，可在另一台电脑继续编辑。</p>
          <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={!projectId || busy === "portable-export"} onClick={() => void startPortableExport()} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-400 px-3 py-1.5 text-[11px] font-bold text-black hover:brightness-110 disabled:opacity-40">{busy === "portable-export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{busy === "portable-export" ? "正在打包…" : "选择位置并导出"}</button><label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-cs2-border px-3 py-1.5 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5"><Archive className="h-3.5 w-3.5" />导入便携包<input type="file" accept=".zip,application/zip" className="hidden" onChange={(event) => { const selected = event.target.files?.[0]; event.target.value = ""; if (selected) void run("portable-import", () => onImportPortable?.(selected)); }} /></label>{busy === "portable-import" ? <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" /> : null}</div>
          {portableJob ? <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${portableJob.status === "error" ? "border-rose-400/30 bg-rose-500/10 text-rose-200" : "border-emerald-400/25 bg-emerald-400/5 text-cs2-text-secondary"}`}>
            {portableJob.status === "error" ? portableJob.error : portableJob.status === "cancelled" ? "已取消打包，未完成的临时包已清理。" : portableJob.status === "done" ? <div className="flex flex-wrap items-center gap-2"><span>{portableJob.saved_path ? `已保存到：${portableJob.saved_path}` : "工程包已生成，可下载到系统默认下载目录。"}</span>{portableJob.saved_path && window.electron?.showItemInFolder ? <button type="button" onClick={() => window.electron.showItemInFolder(portableJob.saved_path)} className="rounded border border-white/15 px-2 py-1 text-[10px] hover:bg-white/5">打开所在文件夹</button> : null}{!portableJob.saved_path && portableJob.download_url ? <a href={portableJob.download_url} className="rounded border border-white/15 px-2 py-1 text-[10px] hover:bg-white/5">下载工程包</a> : null}</div> : <><div className="flex justify-between gap-3"><span>{portableJob.stage === "cancelling" ? "正在取消，当前素材处理完成后停止…" : portableJob.stage === "preparing" ? "正在统计素材…" : portableJob.stage === "compressing" ? "正在压缩素材…" : portableJob.stage === "saving" ? "正在保存到所选位置…" : "正在准备…"}</span><span className="shrink-0">{portableJob.completed_files || 0}/{portableJob.total_files || 0} 个文件 · {formatBytes(portableJob.completed_bytes)}/{formatBytes(portableJob.total_bytes)}</span></div><div className="mt-2 flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-emerald-400 transition-[width]" style={{ width: `${Math.round((portableJob.progress || 0) * 100)}%` }} /></div><button type="button" disabled={portableJob.status === "cancelling"} onClick={() => void cancelPortableExport()} className="rounded border border-rose-400/35 px-2 py-1 text-[10px] font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-50">取消打包</button></div></>}</div> : null}
        </section>
      </div>
    </section>
  </div>;
}
