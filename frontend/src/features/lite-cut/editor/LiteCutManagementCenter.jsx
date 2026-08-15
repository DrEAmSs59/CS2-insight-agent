import { useCallback, useEffect, useState } from "react";
import { Archive, Download, History, Loader2, RefreshCw, RotateCcw, Trash2, Upload, X, Zap } from "lucide-react";
import { liteCutClient } from "../api/liteCutClient.js";
import { desktopBridge } from "../../../desktop/desktopBridge.js";

const formatBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const snapshotLabel = (reason) => ({ before_export: "导出前", before_restore: "恢复前", save: "保存" }[reason] || "快照");

function errorMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (detail?.message) return detail.message;
  return fallback;
}

export default function LiteCutManagementCenter({
  open,
  onClose,
  projectId,
  onRestoreSnapshot,
  onImportProject,
  onExportProject,
}) {
  const [cache, setCache] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [resolution, setResolution] = useState(720);
  const [projectFileResult, setProjectFileResult] = useState(null);

  const refresh = useCallback(async () => {
    if (!open) return;
    setError("");
    try {
      const [cacheResult, snapshotsResult] = await Promise.all([
        liteCutClient.getProxyCache(),
        projectId ? liteCutClient.listSnapshots(projectId) : Promise.resolve({ items: [] }),
      ]);
      setCache(cacheResult || null);
      setResolution(Number(cacheResult?.resolution) || 720);
      setSnapshots(snapshotsResult?.items || []);
    } catch {
      setError("读取管理信息失败，请稍后重试。");
    }
  }, [open, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (name, action, fallback = "操作失败，请稍后重试。") => {
    setBusy(name);
    setError("");
    try {
      const result = await action();
      if (result?.ok === false) throw result.error || new Error(fallback);
      await refresh();
      return result;
    } catch (err) {
      setError(errorMessage(err, fallback));
      return null;
    } finally {
      setBusy("");
    }
  };

  const exportProjectFile = async () => {
    if (!projectId) return;
    setProjectFileResult(null);
    const result = await run("project-export", () => onExportProject?.(), "轻量工程文件导出失败，请稍后重试。");
    const data = result?.data || result;
    if (result?.cancelled || result?.ok === false || !data) return;
    setProjectFileResult({ type: "export", ...data });
  };

  const importProjectFile = async (file) => {
    setProjectFileResult(null);
    const result = await run("project-import", () => onImportProject?.(file), "轻量工程文件导入失败，请检查文件是否有效。");
    const data = result?.data || result;
    if (result?.ok === false || !data) return;
    setProjectFileResult({ type: "import", ...data });
  };

  if (!open) return null;
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="LiteCut 工程管理">
    <section className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-cs2-border bg-cs2-bg-card shadow-2xl">
      <header className="flex items-center justify-between border-b border-cs2-border px-5 py-4">
        <div><h2 className="text-sm font-bold text-cs2-text-primary">工程与缓存管理</h2><p className="mt-1 text-[11px] text-cs2-text-muted">代理缓存、历史版本和轻量链接工程文件</p></div>
        <div className="flex gap-1"><button type="button" title="刷新" onClick={() => void refresh()} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-cs2-text-muted hover:bg-white/5"><RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /></button><button type="button" title="关闭" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-cs2-text-muted hover:bg-white/5"><X className="h-4 w-4" /></button></div>
      </header>
      <div className="min-h-0 overflow-y-auto p-5">
        {error ? <p className="mb-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{String(error)}</p> : null}
        <section className="rounded-xl border border-cs2-border bg-cs2-surface-1/50 p-4">
          <div className="flex items-center gap-2"><Zap className="h-4 w-4 text-cs2-accent" /><h3 className="text-xs font-bold text-cs2-text-primary">代理与缓存</h3></div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["当前代理空间", formatBytes(cache?.proxy_bytes)], ["当前分段", cache?.proxy_files ?? "—"], ["可清理", formatBytes(cache?.orphan_bytes)], ["需代理素材", cache?.proxy_required_assets ?? "—"]].map(([label, value]) => <div key={label} className="rounded-lg bg-black/15 px-3 py-2"><p className="text-[10px] text-cs2-text-muted">{label}</p><p className="mt-0.5 text-sm font-bold text-cs2-text-primary">{value}</p></div>)}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[11px] text-cs2-text-secondary">预览最长边<select value={resolution} onChange={(event) => setResolution(Number(event.target.value))} className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1 text-xs text-cs2-text-primary"><option value={540}>540p</option><option value={720}>720p</option><option value={1080}>1080p</option><option value={1440}>1440p</option></select></label>
            <button type="button" disabled={Boolean(busy)} onClick={() => void run("settings", () => liteCutClient.updateProxySettings(resolution))} className="rounded-md border border-cs2-border px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5 disabled:opacity-50">保存设置</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void run("regen", () => liteCutClient.regenerateProxyCache())} className="rounded-md border border-cs2-accent/40 bg-cs2-accent-soft px-2.5 py-1.5 text-[11px] font-semibold text-cs2-accent disabled:opacity-50">{busy === "regen" ? "正在清空缓存…" : "清空并按需重建"}</button>
            <button type="button" disabled={Boolean(busy) || !(cache?.orphan_files > 0)} onClick={() => void run("cleanup", () => liteCutClient.cleanupProxyCache())} className="rounded-md border border-cs2-border px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5 disabled:opacity-50"><Trash2 className="mr-1 inline h-3.5 w-3.5" />清理无用代理</button>
          </div>
          <p className="mt-2 text-[10px] text-cs2-text-muted">代理会在播放头到达对应位置时按需生成；切换分辨率会清空旧分段。</p>
        </section>
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-surface-1/50 p-4">
          <div className="flex items-center gap-2"><History className="h-4 w-4 text-sky-300" /><h3 className="text-xs font-bold text-cs2-text-primary">工程历史版本</h3><span className="text-[10px] text-cs2-text-muted">保留最近 50 个快照；导出前版本会单独标记</span></div>
          <div className="mt-3 max-h-52 overflow-y-auto rounded-lg border border-cs2-border-subtle">
            {snapshots.length ? snapshots.map((item) => <div key={item.id} className="flex items-center gap-3 border-b border-cs2-border-subtle px-3 py-2 last:border-0"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.reason === "before_export" ? "bg-amber-400/15 text-amber-200" : "bg-white/5 text-cs2-text-secondary"}`}>{snapshotLabel(item.reason)}</span><span className="min-w-0 flex-1 truncate text-[11px] text-cs2-text-secondary">{new Date(item.created_at).toLocaleString()}</span><button type="button" disabled={Boolean(busy)} onClick={() => void run(`restore-${item.id}`, () => onRestoreSnapshot?.(item.id))} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold text-sky-200 hover:bg-sky-400/10 disabled:opacity-50"><RotateCcw className="h-3 w-3" />恢复</button></div>) : <p className="px-3 py-5 text-center text-xs text-cs2-text-muted">保存工程或开始导出后，这里会出现可恢复的版本。</p>}
          </div>
        </section>
        <section className="mt-4 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.04] p-4">
          <div className="flex items-center gap-2"><Archive className="h-4 w-4 text-emerald-300" /><h3 className="text-xs font-bold text-cs2-text-primary">轻量工程文件</h3><span className="rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-200">.litecut</span></div>
          <p className="mt-2 text-[11px] leading-relaxed text-cs2-text-secondary">只保存剪辑结构、素材链接、来源语义和内容校验信息，不复制视频、音频或图片。换电脑后即使素材缺失，工程也能打开；通过“重新定位”指定同一素材并校验通过后即可恢复。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={!projectId || Boolean(busy)} onClick={() => void exportProjectFile()} className="inline-flex items-center gap-1.5 rounded-md bg-emerald-400 px-3 py-1.5 text-[11px] font-bold text-black hover:brightness-110 disabled:opacity-40">{busy === "project-export" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{busy === "project-export" ? "正在写入…" : "选择位置并导出"}</button>
            <label className={`inline-flex items-center gap-1.5 rounded-md border border-cs2-border px-3 py-1.5 text-[11px] font-semibold text-cs2-text-secondary hover:bg-white/5 ${busy ? "pointer-events-none opacity-50" : "cursor-pointer"}`}><Upload className="h-3.5 w-3.5" />导入工程文件<input type="file" accept=".litecut,application/vnd.litecut.project+json" className="hidden" onChange={(event) => { const selected = event.target.files?.[0]; event.target.value = ""; if (selected) void importProjectFile(selected); }} /></label>
          </div>
          {projectFileResult ? <div className="mt-3 rounded-lg border border-emerald-400/25 bg-black/10 px-3 py-2 text-[11px] text-cs2-text-secondary">
            {projectFileResult.type === "export" ? <div className="flex flex-wrap items-center gap-2"><span>{projectFileResult.saved_path ? `已保存：${projectFileResult.saved_path}` : `工程文件已生成（${formatBytes(projectFileResult.file_size)}）`}</span><span className="text-cs2-text-muted">{projectFileResult.asset_count || 0} 个素材引用</span>{projectFileResult.saved_path && desktopBridge?.showItemInFolder ? <button type="button" onClick={() => void desktopBridge.showItemInFolder(projectFileResult.saved_path)} className="rounded border border-white/15 px-2 py-1 text-[10px] hover:bg-white/5">打开所在文件夹</button> : null}{!projectFileResult.saved_path && projectFileResult.download_url ? <a href={projectFileResult.download_url} className="rounded border border-white/15 px-2 py-1 text-[10px] hover:bg-white/5">下载工程文件</a> : null}</div> : <span>工程已导入：{projectFileResult.asset_count || 0} 个素材引用，{projectFileResult.offline_asset_count || 0} 个素材等待重新定位。</span>}
          </div> : null}
        </section>
      </div>
    </section>
  </div>;
}
