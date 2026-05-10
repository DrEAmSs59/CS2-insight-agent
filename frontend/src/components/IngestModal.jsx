import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import {
  X,
  Search,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Database,
  RefreshCcw,
  Plus,
  HardDrive,
  Upload,
} from "lucide-react";

const API = axios.create({ baseURL: "/api" });

const SOURCE_LABELS = {
  "Faceit": "Faceit",
  "5E": "5E",
  "Perfect World": "完美",
  "Matchmaking": "官匹",
  "ESL": "ESL",
  "ESEA": "ESEA",
  "Blast": "Blast",
  "Local/Other": "本地",
};

export default function IngestModal({ isOpen, onClose, onIngest, onUpload }) {
  const [items, setItems] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingestError, setIngestError] = useState(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedIds, setSelectedIds] = useState(new Set());

  const limit = 10;

  const fileInputRef = React.useRef(null);

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onUpload?.(files);
      e.target.value = ""; // reset
    }
  };

  const fetchDiscovered = useCallback(async () => {
    setListLoading(true);
    try {
      const params = { limit, offset: (page - 1) * limit };
      if (search.trim()) params.q = search.trim();

      const { data } = await API.get("/demos/discovered", { params });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      console.error("Failed to fetch discovered demos", e);
    } finally {
      setListLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    if (isOpen) {
      setIngestError(null);
      setIngesting(false);
      fetchDiscovered();
    }
  }, [isOpen, fetchDiscovered]);

  if (!isOpen) return null;

  const totalPages = Math.ceil(total / limit) || 1;

  const handleToggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleIngestSelected = async () => {
    if (selectedIds.size === 0 || ingesting || !onIngest) return;
    const ids = Array.from(selectedIds);
    setIngestError(null);
    setIngesting(true);
    try {
      await onIngest?.(ids);
      setSelectedIds(new Set());
      await fetchDiscovered();
      onClose();
    } catch (e) {
      const d = e?.response?.data?.detail;
      const msg = Array.isArray(d)
        ? d.map((x) => (typeof x === "object" && x?.msg ? x.msg : String(x))).join("；")
        : typeof d === "string"
          ? d
          : e?.message || "入库失败";
      setIngestError(msg);
    } finally {
      setIngesting(false);
    }
  };

  const handleSelectAll = () => {
    setSelectedIds(new Set(items.map((it) => it.id)));
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4 py-6 backdrop-blur-sm">
      <div className="relative flex h-full max-h-[600px] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-cs2-bg-card shadow-2xl">
        {ingesting ? (
          <div
            className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-[1px]"
            aria-busy="true"
            aria-label="正在入库"
          >
            <Loader2 className="h-8 w-8 animate-spin text-cs2-orange" />
            <p className="text-xs font-semibold text-zinc-200">正在入库，请稍候…</p>
          </div>
        ) : null}
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-cs2-orange" />
            <h2 className="text-sm font-bold text-white">待入库 Demo</h2>
            <span className="rounded bg-cs2-orange/10 px-1.5 py-0.5 text-[10px] font-bold text-cs2-orange">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="file"
              multiple
              accept=".dem"
              className="hidden"
              ref={fileInputRef}
              onChange={handleFileChange}
            />
            <button
              type="button"
              disabled={ingesting}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-bold text-zinc-400 transition-all hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Upload className="h-3.5 w-3.5" />
              本地浏览并导入
            </button>
            <button
              type="button"
              disabled={ingesting}
              onClick={onClose}
              className="rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b border-white/5 bg-black/20 px-5 py-3">
          <div className="flex flex-1 items-center gap-2 rounded-md border border-white/10 bg-cs2-bg-input px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="搜索文件名..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="flex-1 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </div>
          <button
            type="button"
            disabled={ingesting}
            onClick={() => void fetchDiscovered()}
            className="flex items-center justify-center rounded-md border border-white/10 p-1.5 text-zinc-400 hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCcw className={`h-4 w-4 ${listLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Selection bar */}
        {items.length > 0 && (
          <div className="flex items-center gap-2 border-b border-white/5 bg-black/10 px-5 py-2 text-[10px]">
            <button type="button" disabled={ingesting} onClick={handleSelectAll} className="text-zinc-400 hover:text-zinc-200 disabled:opacity-40">
              本页全选
            </button>
            <span className="text-zinc-600">|</span>
            <button type="button" disabled={ingesting} onClick={handleClearSelection} className="text-zinc-400 hover:text-zinc-200 disabled:opacity-40">
              清空
            </button>
            <span className="ml-auto text-zinc-500">已选 {selectedIds.size} / {items.length}</span>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2">
          {listLoading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-600" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-zinc-600">
              <HardDrive className="h-8 w-8 opacity-20" />
              <p className="text-xs">
                {search
                  ? "没有找到匹配的待入库 Demo"
                  : "没有待入库的 Demo，请点击工具栏「扫描本地 demo 库」发现新文件，再打开本窗口查看"}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {items.map((it) => {
                const sourceLabel = SOURCE_LABELS[it.source] || "本地";
                const sizeMB = it.file_size != null ? (it.file_size / (1024 * 1024)).toFixed(1) : "?";
                return (
                  <div
                    key={it.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => !ingesting && handleToggleSelect(it.id)}
                    onKeyDown={(e) => {
                      if (ingesting) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleToggleSelect(it.id);
                      }
                    }}
                    className={`flex items-center justify-between rounded-md border p-2.5 transition-colors ${ingesting ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${selectedIds.has(it.id) ? "border-cs2-orange/40 bg-cs2-orange/5" : "border-transparent hover:bg-white/5"}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        readOnly
                        checked={selectedIds.has(it.id)}
                        className="h-3.5 w-3.5 rounded border-white/20 bg-transparent text-cs2-orange focus:ring-offset-0"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-mono text-zinc-300" title={it.path}>{it.filename}</p>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
                          <span>{sourceLabel}</span>
                          <span>•</span>
                          <span>{sizeMB} MB</span>
                          <span>•</span>
                          <span>发现于 {new Date(it.added_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 border-t border-white/10 bg-cs2-bg-dark px-5 py-3">
          {ingestError ? (
            <p className="text-center text-[11px] leading-snug text-red-400">{ingestError}</p>
          ) : null}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={page <= 1 || ingesting}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-md border border-white/10 p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-[11px] text-zinc-500">
                第 {page} / {totalPages} 页
              </span>
              <button
                type="button"
                disabled={page >= totalPages || ingesting}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-md border border-white/10 p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-300 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={selectedIds.size === 0 || ingesting}
                onClick={() => void handleIngestSelected()}
                className="flex items-center gap-1.5 rounded-lg bg-cs2-orange px-4 py-2 text-xs font-extrabold text-black shadow-lg shadow-cs2-orange/20 transition-all hover:bg-cs2-orange-light disabled:opacity-50 disabled:grayscale"
              >
                {ingesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                确认入库 ({selectedIds.size})
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
