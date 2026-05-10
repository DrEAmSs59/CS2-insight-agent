import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Film,
  FolderOpen,
  Loader2,
  Music,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

const API = axios.create({ baseURL: "/api" });

/* ─── 工具函数 ─── */
function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

function basename(p) {
  if (!p) return "";
  return p.replace(/\\/g, "/").split("/").pop() || p;
}

function dirname(p) {
  if (!p) return "";
  const n = p.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i > 0 ? n.slice(0, i) : n;
}

/* ─── 转场摘要 ─── */
const TRANSITION_LABELS = {
  none: "无转场", cut: "快切", fade: "淡入淡出",
  flash: "闪白", dip_black: "黑场", zoom: "轻微缩放",
};
function transitionSummary(transitions) {
  if (!transitions || !Object.keys(transitions).length) return null;
  const counts = {};
  for (const v of Object.values(transitions)) {
    const t = v?.type || "cut";
    counts[t] = (counts[t] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${TRANSITION_LABELS[t] ?? t} ×${n}`)
    .join("　");
}

/* ─── 片段类别汉化 ─── */
const CATEGORY_LABELS = {
  highlight: "高光", fail: "下饭", meme_death: "梗",
  compilation: "合集", timeline: "时间线",
};
function categoryLabel(c) { return CATEGORY_LABELS[c] ?? c ?? "—"; }

/* ─── 主题 ─── */
const THEME_LABELS = {
  esports: "竞技快切", film: "电影感", funny: "下饭搞笑", clean: "无转场",
};

/* ─── 内联重命名 ─── */
function InlineRename({ current, onSave, onCancel }) {
  const [val, setVal] = useState(current || "");
  const ref = useRef(null);
  useEffect(() => { setTimeout(() => ref.current?.select(), 0); }, []);
  const commit = () => val.trim() ? onSave(val.trim()) : onCancel();
  return (
    <input
      ref={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onCancel(); }}
      onClick={(e) => e.stopPropagation()}
      className="w-full rounded border border-cs2-orange/70 bg-black/50 px-2 py-0.5 text-[13px] font-semibold text-white outline-none focus:border-cs2-orange"
      maxLength={120}
    />
  );
}

/* ─── 单条片段标签 ─── */
function ClipPill({ clip }) {
  const category = clip.category;
  const map = clip.map_name?.replace("de_", "") ?? "?";
  const kills = clip.kill_count ?? null;
  const tags = clip.context_tags ?? [];
  const player = clip.player_name;
  const dur = clip.duration_sec ? `${clip.duration_sec.toFixed(1)}s` : null;
  const colorMap = {
    highlight: "bg-cs2-orange/15 text-cs2-orange border-cs2-orange/30",
    fail: "bg-blue-500/10 text-blue-300 border-blue-500/20",
    meme_death: "bg-purple-500/10 text-purple-300 border-purple-500/20",
    compilation: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  };
  const cls = colorMap[category] ?? "bg-white/[0.05] text-zinc-400 border-white/10";

  return (
    <div className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${cls}`}>
      <span className="font-semibold">{categoryLabel(category)}</span>
      <span className="text-zinc-500">·</span>
      <span>{map}</span>
      {kills != null && <><span className="text-zinc-500">·</span><span>{kills}K</span></>}
      {player && <><span className="text-zinc-500">·</span><span className="max-w-[64px] truncate opacity-70">{player}</span></>}
      {dur && <><span className="text-zinc-500">·</span><span className="opacity-60">{dur}</span></>}
      {tags.slice(0, 2).map((t) => (
        <span key={t} className="ml-0.5 rounded bg-white/[0.06] px-1 text-[9px] text-zinc-500">{t}</span>
      ))}
    </div>
  );
}

/* ─── 单条导出记录 ─── */
function ExportRow({ item, selected, onSelect, onOpenFolder, onDelete, onRename }) {
  const [renaming, setRenaming] = useState(false);
  const ok = item.status === "done";
  const isErr = item.status === "error";
  const running = item.status === "running" || item.status === "pending";
  const body = item.body ?? {};
  const clips = item.clips_preview ?? [];
  const displayName = item.name || basename(item.output_path) || "未命名";
  const themeLabel = body.theme_id && body.theme_id !== "custom" ? (THEME_LABELS[body.theme_id] ?? body.theme_id) : null;
  const hasBgm = Boolean(body.bgm_path);
  const hasIntro = Boolean(body.intro_path);
  const hasOutro = Boolean(body.outro_path);
  const tSummary = transitionSummary(body.transitions);

  return (
    <div
      className={`rounded-xl border transition-colors ${
        selected
          ? "border-cs2-orange/40 bg-cs2-orange/5"
          : ok
            ? "border-white/[0.07] bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.035]"
            : isErr
              ? "border-red-500/20 bg-red-950/10"
              : "border-white/[0.05] bg-white/[0.015]"
      }`}
    >
      {/* 头部 */}
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        {/* 复选框 */}
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-cs2-orange"
        />

        {/* 状态图标 */}
        <div className="mt-0.5 shrink-0">
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
          ) : ok ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          ) : (
            <AlertCircle className="h-4 w-4 text-red-400" />
          )}
        </div>

        {/* 名称 + 元信息 */}
        <div className="min-w-0 flex-1">
          {renaming ? (
            <InlineRename
              current={item.name || ""}
              onSave={(name) => { setRenaming(false); onRename(item.id, name); }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <p
              className="cursor-text truncate text-[13px] font-semibold text-zinc-100"
              title="双击重命名"
              onDoubleClick={() => setRenaming(true)}
            >
              {displayName}
            </p>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {formatDateTime(item.created_at)}
            </span>
            {clips.length > 0 && <span>{clips.length} 段</span>}
            {themeLabel && (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-zinc-400">{themeLabel}</span>
            )}
            {hasBgm && (
              <span className="flex items-center gap-0.5">
                <Music className="h-2.5 w-2.5" />BGM
              </span>
            )}
            {(hasIntro || hasOutro) && (
              <span>{[hasIntro && "片头", hasOutro && "片尾"].filter(Boolean).join("+")}</span>
            )}
            {isErr && item.error_msg && (
              <span className="text-red-400/80">{item.error_msg}</span>
            )}
          </div>
          {tSummary && (
            <p className="mt-0.5 text-[10px] text-zinc-600">转场：{tSummary}</p>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex shrink-0 items-center gap-1">
          {ok && item.output_path && (
            <button
              type="button"
              title="打开文件夹"
              onClick={() => onOpenFolder(dirname(item.output_path))}
              className="rounded p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            title="删除"
            onClick={() => onDelete([item.id])}
            className="rounded p-1.5 text-zinc-600 hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 片段时间线 */}
      {clips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-white/[0.04] px-4 py-2">
          {clips.map((clip, i) => (
            <ClipPill key={clip.id ?? i} clip={clip} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── 删除确认 Dialog ─── */
function DeleteConfirmDialog({ count, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#18181c] p-5 shadow-2xl">
        <h3 className="mb-2 text-[14px] font-bold text-white">确认删除</h3>
        <p className="mb-1 text-[12px] text-zinc-300">
          将删除 <span className="font-semibold text-cs2-orange">{count}</span> 条历史记录。
        </p>
        <p className="mb-4 text-[11px] leading-relaxed text-zinc-500">
          同时勾选「删除磁盘文件」将把对应的 .mp4 文件从硬盘中删除，<span className="text-red-400">此操作不可恢复</span>。
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => onConfirm(false)}
            className="flex-1 rounded-lg border border-white/10 py-2 text-[12px] font-semibold text-zinc-300 hover:bg-white/[0.06]"
          >
            仅删除记录
          </button>
          <button
            type="button"
            onClick={() => onConfirm(true)}
            className="flex-1 rounded-lg bg-red-600 py-2 text-[12px] font-semibold text-white hover:bg-red-500"
          >
            同时删除文件
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-4 py-2 text-[12px] text-zinc-500 hover:text-zinc-300"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── 主 Dialog ─── */
export default function MontageHistoryPanel({ open, onClose }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [pendingDelete, setPendingDelete] = useState(null); // null | int[]
  const PAGE_SIZE = 15;

  const load = useCallback(async (pageIdx = 0) => {
    setLoading(true);
    try {
      const { data } = await API.get("/montage/exports", {
        params: { limit: PAGE_SIZE, offset: pageIdx * PAGE_SIZE },
      });
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setPage(pageIdx);
      setSelectedIds(new Set());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) load(0); }, [open, load]);

  const openFolder = useCallback(async (dir) => {
    if (!dir) return;
    try { await API.post("/open-folder", { path: dir }); } catch { /* 静默 */ }
  }, []);

  // 删除入口（单条 or 批量均走这里）
  const requestDelete = useCallback((ids) => setPendingDelete(ids), []);

  const confirmDelete = useCallback(async (deleteFiles) => {
    if (!pendingDelete?.length) return;
    setPendingDelete(null);
    try {
      if (pendingDelete.length === 1) {
        await API.delete(`/montage/exports/${pendingDelete[0]}`, {
          params: { delete_file: deleteFiles },
        });
        setItems((prev) => prev.filter((it) => !pendingDelete.includes(it.id)));
        setTotal((t) => Math.max(0, t - 1));
      } else {
        await API.post("/montage/exports/batch-delete", {
          ids: pendingDelete,
          delete_files: deleteFiles,
        });
        setItems((prev) => prev.filter((it) => !pendingDelete.includes(it.id)));
        setTotal((t) => Math.max(0, t - pendingDelete.length));
      }
      setSelectedIds(new Set());
    } catch { /* 静默 */ }
  }, [pendingDelete]);

  const handleRename = useCallback(async (id, name) => {
    try {
      await API.patch(`/montage/exports/${id}`, { name });
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, name } : it)));
    } catch { /* 静默 */ }
  }, []);

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === items.length ? new Set() : new Set(items.map((it) => it.id))
    );
  }, [items]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const someSelected = selectedIds.size > 0;

  if (!open) return null;

  return (
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-6">
        <div
          className="flex h-full max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111114] shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 头部 */}
          <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-6 py-4">
            <Film className="h-5 w-5 shrink-0 text-cs2-orange" />
            <div className="flex-1">
              <h2 className="text-[15px] font-bold text-white">合集历史</h2>
              <p className="text-[11px] text-zinc-500">共 {total} 条记录 · 双击名称可重命名</p>
            </div>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
            <button
              type="button"
              onClick={() => load(page)}
              title="刷新"
              className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {/* 批量操作栏 */}
          <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.04] px-6 py-2">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
              onChange={toggleSelectAll}
              className="h-3.5 w-3.5 accent-cs2-orange"
            />
            <span className="text-[11px] text-zinc-500">
              {someSelected ? `已选 ${selectedIds.size} 条` : "全选"}
            </span>
            {someSelected && (
              <button
                type="button"
                onClick={() => requestDelete([...selectedIds])}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-1.5 text-[11px] font-semibold text-red-300 hover:bg-red-900/40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除选中 ({selectedIds.size})
              </button>
            )}
          </div>

          {/* 列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {loading && items.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-zinc-600">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-3 text-zinc-600">
                <Film className="h-8 w-8 opacity-30" />
                <span className="text-[12px]">暂无导出记录</span>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {items.map((item) => (
                  <ExportRow
                    key={item.id}
                    item={item}
                    selected={selectedIds.has(item.id)}
                    onSelect={() => toggleSelect(item.id)}
                    onOpenFolder={openFolder}
                    onDelete={requestDelete}
                    onRename={handleRename}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 翻页 */}
          {totalPages > 1 && (
            <div className="flex shrink-0 items-center justify-center gap-4 border-t border-white/[0.06] px-6 py-3">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => load(page - 1)}
                className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-[11px] text-zinc-500">
                第 {page + 1} 页 / 共 {totalPages} 页
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => load(page + 1)}
                className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 删除确认 */}
      {pendingDelete && (
        <DeleteConfirmDialog
          count={pendingDelete.length}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}
