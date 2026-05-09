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
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

const API = axios.create({ baseURL: "/api" });

/* ─── 时间格式化 ─── */
function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    // isoformat() 输出 "+00:00" 结尾，直接 new Date() 解析，不额外追加 Z
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
    return d.toLocaleString("zh-CN", {
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

/* ─── 转场统计 ─── */
const TRANSITION_LABELS = {
  none: "无转场",
  cut: "快切",
  fade: "淡入淡出",
  flash: "闪白",
  dip_black: "黑场",
  zoom: "轻微缩放",
};

function summarizeTransitions(transitions) {
  if (!transitions || typeof transitions !== "object") return null;
  const counts = {};
  for (const v of Object.values(transitions)) {
    const t = v?.type || "cut";
    counts[t] = (counts[t] || 0) + 1;
  }
  const entries = Object.entries(counts);
  if (!entries.length) return null;
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${TRANSITION_LABELS[t] ?? t}×${n}`)
    .join("  ");
}

/* ─── 主题标签 ─── */
const THEME_LABELS = {
  esports: "竞技快切",
  film: "电影感",
  funny: "下饭搞笑",
  clean: "无转场",
};

/* ─── 内联重命名 ─── */
function InlineRename({ current, onSave, onCancel }) {
  const [val, setVal] = useState(current || "");
  const ref = useRef(null);
  useEffect(() => { ref.current?.select(); }, []);
  const submit = () => { if (val.trim()) onSave(val.trim()); else onCancel(); };
  return (
    <input
      ref={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") onCancel();
      }}
      className="w-full rounded border border-cs2-orange/60 bg-black/40 px-1.5 py-0.5 text-[12px] text-white outline-none focus:border-cs2-orange"
      maxLength={120}
    />
  );
}

/* ─── 单条记录 ─── */
function ExportRow({ item, onOpenFolder, onDelete, onRename }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const ok = item.status === "done";
  const isErr = item.status === "error";
  const running = item.status === "running" || item.status === "pending";
  const body = item.body ?? {};

  const displayName = item.name || basename(item.output_path) || "未命名";
  const filename = basename(item.output_path);

  const clipCount =
    body.recorded_clip_ids?.length ?? body.ordered_ids?.length ?? null;
  const transitionSummary = summarizeTransitions(body.transitions);
  const themeLabel = body.theme_id && body.theme_id !== "custom"
    ? (THEME_LABELS[body.theme_id] ?? body.theme_id)
    : null;
  const hasBgm = Boolean(body.bgm_path);
  const hasIntro = Boolean(body.intro_path);
  const hasOutro = Boolean(body.outro_path);

  return (
    <div
      className={`group rounded-lg border px-3 py-2.5 transition-colors ${
        ok
          ? "border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.05]"
          : isErr
            ? "border-red-500/20 bg-red-950/20"
            : "border-white/[0.06] bg-white/[0.02]"
      }`}
    >
      {/* 头部行：状态图标 + 名称 + 操作按钮 */}
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
          ) : ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-red-400" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          {renaming ? (
            <InlineRename
              current={item.name || ""}
              onSave={(name) => { setRenaming(false); onRename(item.id, name); }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <div
              className="group/name flex cursor-pointer items-center gap-1"
              onDoubleClick={() => setRenaming(true)}
              title="双击重命名"
            >
              <span className="truncate text-[12px] font-semibold text-zinc-100">
                {displayName}
              </span>
              <Pencil className="h-2.5 w-2.5 shrink-0 text-zinc-600 opacity-0 transition-opacity group-hover/name:opacity-100" />
            </div>
          )}
          {/* 文件名（与展示名不同时展示） */}
          {filename && filename !== displayName && (
            <p className="truncate text-[10px] text-zinc-600">{filename}</p>
          )}
        </div>

        {/* 操作按钮组 */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            title="重命名"
            onClick={() => setRenaming(true)}
            className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
          >
            <Pencil className="h-3 w-3" />
          </button>
          {ok && item.output_path && (
            <button
              type="button"
              title="打开所在文件夹"
              onClick={() => onOpenFolder(dirname(item.output_path))}
              className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            >
              <FolderOpen className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            title="删除记录"
            onClick={() => setConfirmDelete(true)}
            className="rounded p-1 text-zinc-500 hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* 删除确认 */}
      {confirmDelete && (
        <div className="mt-2 flex items-center justify-between rounded bg-red-950/40 px-2 py-1.5">
          <span className="text-[10px] text-red-300">确认删除该记录？</span>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => { setConfirmDelete(false); onDelete(item.id); }}
              className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500"
            >
              删除
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded border border-white/10 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 详情行 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1">
          <Clock className="h-2.5 w-2.5 shrink-0" />
          {formatDateTime(item.created_at)}
        </span>

        {clipCount != null && (
          <span className="flex items-center gap-1">
            <Film className="h-2.5 w-2.5 shrink-0" />
            {clipCount} 段
          </span>
        )}

        {themeLabel && (
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-zinc-400">
            {themeLabel}
          </span>
        )}

        {hasBgm && (
          <span className="flex items-center gap-0.5 text-zinc-500">
            <Music className="h-2.5 w-2.5 shrink-0" />
            BGM
          </span>
        )}

        {(hasIntro || hasOutro) && (
          <span className="text-zinc-600">
            {[hasIntro && "片头", hasOutro && "片尾"].filter(Boolean).join(" + ")}
          </span>
        )}

        {isErr && item.error_msg && (
          <span className="text-red-400/80">{item.error_msg}</span>
        )}
      </div>

      {/* 转场摘要 */}
      {transitionSummary && (
        <p className="mt-1 pl-5 text-[10px] text-zinc-600">
          转场：{transitionSummary}
        </p>
      )}
    </div>
  );
}

/* ─── 主面板 ─── */
export default function MontageHistoryPanel({ open, onClose }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  const load = useCallback(async (pageIdx = 0) => {
    setLoading(true);
    try {
      const { data } = await API.get("/montage/exports", {
        params: { limit: PAGE_SIZE, offset: pageIdx * PAGE_SIZE },
      });
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setPage(pageIdx);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load(0);
  }, [open, load]);

  const openFolder = useCallback(async (dir) => {
    if (!dir) return;
    try { await API.post("/open-folder", { path: dir }); } catch { /* 非 Windows 静默 */ }
  }, []);

  const handleDelete = useCallback(async (id) => {
    try {
      await API.delete(`/montage/exports/${id}`);
      setItems((prev) => prev.filter((it) => it.id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } catch { /* 静默 */ }
  }, []);

  const handleRename = useCallback(async (id, name) => {
    try {
      await API.patch(`/montage/exports/${id}`, { name });
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, name } : it))
      );
    } catch { /* 静默 */ }
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!open) return null;

  return (
    <>
      <div className="absolute inset-0 z-20 bg-black/40" onClick={onClose} aria-hidden />

      <aside className="absolute inset-y-0 right-0 z-30 flex w-[340px] flex-col border-l border-white/[0.08] bg-[#0f0f13] shadow-2xl">
        {/* 头部 */}
        <header className="flex h-[48px] shrink-0 items-center gap-2 border-b border-white/[0.06] px-4">
          <Film className="h-4 w-4 shrink-0 text-cs2-orange" />
          <span className="flex-1 text-[13px] font-bold text-white">合集历史</span>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
          <button
            type="button"
            onClick={() => load(page)}
            title="刷新"
            className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* 统计条 */}
        <div className="shrink-0 border-b border-white/[0.04] px-4 py-1.5 text-[10px] text-zinc-600">
          共 {total} 条 · 双击名称可重命名
        </div>

        {/* 列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {loading && items.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-zinc-600">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-zinc-600">
              <Film className="h-6 w-6 opacity-40" />
              <span className="text-[11px]">暂无导出记录</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((item) => (
                <ExportRow
                  key={item.id}
                  item={item}
                  onOpenFolder={openFolder}
                  onDelete={handleDelete}
                  onRename={handleRename}
                />
              ))}
            </div>
          )}
        </div>

        {/* 翻页 */}
        {totalPages > 1 && (
          <div className="flex shrink-0 items-center justify-between border-t border-white/[0.06] px-4 py-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => load(page - 1)}
              className="rounded p-1 text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-[10px] text-zinc-600">
              {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => load(page + 1)}
              className="rounded p-1 text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
