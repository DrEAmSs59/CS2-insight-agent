import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { X, Clapperboard, Loader2 } from "lucide-react";
import MontageThemeSelector from "./montage/MontageThemeSelector";
import RecordedClipCard from "./montage/RecordedClipCard";
import MontageTimeline from "./montage/MontageTimeline";
import MontageExportSettings from "./montage/MontageExportSettings";
import MontageExportResult from "./montage/MontageExportResult";
import {
  MONTAGE_THEMES,
  themeLabel,
  sortClipsByStrategy,
  buildDefaultExportName,
  ensureMp4Filename,
  stripMp4Extension,
  isClipMatchedBySearch,
  clipMatchesFilter,
  getClipDurationSeconds,
  formatMontageEstimate,
} from "../utils/montageUtils";

const API = axios.create({ baseURL: "/api" });

const FILTER_KEYS = [
  { id: "all", label: "全部" },
  { id: "高光", label: "高光" },
  { id: "下饭", label: "下饭" },
  { id: "梗死亡", label: "梗死亡" },
  { id: "击杀", label: "击杀" },
  { id: "普通片段", label: "普通片段" },
  { id: "joined", label: "已加入" },
  { id: "unjoined", label: "未加入" },
];

function humanizeExportError(err) {
  const s = String(err || "").trim();
  if (!s) return "导出失败，请稍后重试。";
  if (s.includes("recorded_clip_ids") || s.includes("不能为空")) return "请先从左侧素材库加入至少一个片段。";
  return s;
}

export default function MontageWorkbenchDrawer({ open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [orderedIds, setOrderedIds] = useState([]);
  const [bgmPath, setBgmPath] = useState("");
  const [introPath, setIntroPath] = useState("");
  const [outroPath, setOutroPath] = useState("");
  const [outputFilename, setOutputFilename] = useState(() => buildDefaultExportName("custom"));
  const [filenameTouched, setFilenameTouched] = useState(false);
  const [outputDir, setOutputDir] = useState("");
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [draftName, setDraftName] = useState("");
  const [selectedThemeId, setSelectedThemeId] = useState("custom");
  const [filterKey, setFilterKey] = useState("all");
  const [searchQ, setSearchQ] = useState("");
  const [toast, setToast] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const toastTimer = useRef(null);

  const showToast = useCallback((msg) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 3200);
  }, []);

  const loadClips = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await API.get("/recorded-clips", { params: { limit: 500, offset: 0 } });
      setItems(data.items || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadClips();
  }, [open, loadClips]);

  const byId = useMemo(() => {
    const m = new Map();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  const orderedIdSet = useMemo(() => new Set(orderedIds), [orderedIds]);

  const orderedClips = useMemo(() => orderedIds.map((id) => byId.get(id)).filter(Boolean), [orderedIds, byId]);

  const unknownDurationHint = useMemo(() => {
    if (orderedClips.length === 0) return null;
    const anyUnknown = orderedClips.some((c) => getClipDurationSeconds(c) == null);
    return anyUnknown ? "部分片段时长未知，导出时以后端为准" : null;
  }, [orderedClips]);

  const totalKnownSeconds = useMemo(() => {
    let s = 0;
    for (const c of orderedClips) {
      const d = getClipDurationSeconds(c);
      if (d != null) s += d;
    }
    return s;
  }, [orderedClips]);

  const filteredLibrary = useMemo(() => {
    return items.filter((clip) => {
      if (!clipMatchesFilter(clip, filterKey, orderedIdSet)) return false;
      return isClipMatchedBySearch(clip, searchQ);
    });
  }, [items, filterKey, searchQ, orderedIdSet]);

  const addToSequence = useCallback((id) => {
    setOrderedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const removeFromSequence = useCallback((id) => {
    setOrderedIds((prev) => prev.filter((x) => x !== id));
  }, []);

  const move = useCallback((id, dir) => {
    setOrderedIds((prev) => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const handleSort = useCallback(
    (strategy) => {
      const clips = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      const sorted = sortClipsByStrategy(clips, strategy);
      setOrderedIds(sorted.map((c) => c.id));
    },
    [orderedIds, byId],
  );

  const onSelectTheme = useCallback(
    (id) => {
      setSelectedThemeId(id);
      if (!filenameTouched) {
        setOutputFilename(buildDefaultExportName(id));
      }
    },
    [filenameTouched],
  );

  const validateExport = useCallback(() => {
    if (orderedIds.length < 1) {
      return "请先从左侧素材库加入至少一个片段。";
    }
    const name = outputFilename.trim();
    if (!name) {
      return "请填写视频名称。";
    }
    if (!outputDir.trim()) {
      return "请填写输出位置。";
    }
    return null;
  }, [orderedIds.length, outputFilename, outputDir]);

  const saveDraft = useCallback(async () => {
    const effectiveName =
      draftName.trim() || stripMp4Extension(outputFilename).trim() || outputFilename.trim();
    if (!effectiveName) {
      window.alert("请填写草稿名称，或先填写视频名称。");
      return;
    }
    setSavingDraft(true);
    try {
      const { data } = await API.post("/montage/projects", {
        project_id: projectId,
        name: effectiveName,
        recorded_clip_ids: orderedIds,
        bgm_path: bgmPath.trim() || null,
        intro_path: introPath.trim() || null,
        outro_path: outroPath.trim() || null,
        output_filename: ensureMp4Filename(outputFilename.trim()) || "montage_export.mp4",
      });
      setProjectId(data.id);
      showToast("草稿已保存");
    } catch (e) {
      window.alert(e.response?.data?.detail || e.message || "保存失败");
    } finally {
      setSavingDraft(false);
    }
  }, [projectId, draftName, outputFilename, orderedIds, bgmPath, introPath, outroPath, showToast]);

  const runExport = useCallback(async () => {
    const err = validateExport();
    if (err) {
      window.alert(err);
      return;
    }
    const dir = outputDir.trim();
    const fn = ensureMp4Filename(outputFilename.trim());
    const sep = dir.includes("\\") ? "\\" : "/";
    const outPath = dir.replace(/[/\\]+$/, "") + sep + fn;
    setExporting(true);
    setLastExport(null);
    try {
      const { data } = await API.post("/montage/export", {
        project_id: projectId,
        recorded_clip_ids: orderedIds.length ? orderedIds : undefined,
        bgm_path: bgmPath.trim() || null,
        intro_path: introPath.trim() || null,
        outro_path: outroPath.trim() || null,
        output_path: outPath,
        theme_id: selectedThemeId,
      });
      setLastExport({ ok: true, ...data });
    } catch (e) {
      const detail = e.response?.data?.detail;
      setLastExport({ ok: false, err: humanizeExportError(detail || e.message) });
    } finally {
      setExporting(false);
    }
  }, [
    validateExport,
    projectId,
    orderedIds,
    bgmPath,
    introPath,
    outroPath,
    outputDir,
    outputFilename,
    selectedThemeId,
  ]);

  const copyText = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制到剪贴板");
    } catch {
      window.alert("复制失败，请手动选择文本复制。");
    }
  }, [showToast]);

  if (!open) return null;

  const durationText = formatMontageEstimate(totalKnownSeconds, orderedIds.length);

  return (
    <div
      className="fixed inset-0 z-[110] flex justify-end bg-black/55 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="montage-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-[min(1200px,96vw)] flex-col border-l border-white/10 bg-cs2-bg-card shadow-2xl">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Clapperboard className="h-4 w-4 shrink-0 text-cs2-orange" />
              <h2 id="montage-title" className="text-sm font-bold text-white">
                合辑工作台
              </h2>
            </div>
            <span className="hidden h-4 w-px bg-white/15 sm:block" aria-hidden />
            <p className="text-[11px] text-zinc-400">
              主题：<span className="font-medium text-cs2-orange">{themeLabel(selectedThemeId)}</span>
            </p>
            <p className="text-[11px] text-zinc-500">
              当前合辑：{orderedIds.length} 个片段 · 预计 {formatMontageEstimate(totalKnownSeconds, orderedIds.length)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={exporting}
              onClick={() => void runExport()}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-cs2-orange/55 bg-cs2-orange/20 px-4 py-2.5 text-[12px] font-bold text-cs2-orange hover:bg-cs2-orange/30 disabled:opacity-40"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
              导出合辑
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {toast ? (
          <div className="border-b border-emerald-500/30 bg-emerald-950/40 px-4 py-2 text-center text-[11px] text-emerald-200">
            {toast}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <MontageThemeSelector themes={MONTAGE_THEMES} selectedThemeId={selectedThemeId} onSelectTheme={onSelectTheme} />

          <div className="mt-4 grid min-h-[320px] grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
            <div className="flex min-h-0 flex-col space-y-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">已录片段素材库</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {FILTER_KEYS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFilterKey(f.id)}
                      className={`rounded-full border px-2.5 py-1 text-[10px] font-medium ${
                        filterKey === f.id
                          ? "border-cs2-orange/50 bg-cs2-orange/15 text-cs2-orange"
                          : "border-white/10 bg-black/30 text-zinc-400 hover:border-white/20"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <input
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  placeholder="搜索文件名、地图、玩家、AI 锐评…"
                  className="mt-2 w-full rounded border border-white/10 bg-black/40 px-3 py-2 text-[11px] text-zinc-200 placeholder:text-zinc-600"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {loading ? (
                  <div className="flex items-center gap-2 py-10 text-xs text-zinc-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    加载中…
                  </div>
                ) : items.length === 0 ? (
                  <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-6 text-[11px] text-zinc-500">
                    暂无入库片段。完成 OBS 录制成功后会自动出现在此列表。
                  </p>
                ) : filteredLibrary.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">没有符合筛选或搜索条件的片段。</p>
                ) : (
                  <ul className="space-y-2">
                    {filteredLibrary.map((clip) => (
                      <li key={clip.id}>
                        <RecordedClipCard
                          clip={clip}
                          isAdded={orderedIdSet.has(clip.id)}
                          onAdd={addToSequence}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <MontageTimeline
              clips={orderedClips}
              onMoveUp={(id) => move(id, -1)}
              onMoveDown={(id) => move(id, 1)}
              onRemove={removeFromSequence}
              onSort={handleSort}
              unknownDurationHint={unknownDurationHint}
            />
          </div>

          <div className="mt-6 space-y-4">
            {exporting ? (
              <div className="rounded-lg border border-amber-500/35 bg-amber-950/30 px-4 py-3 text-[11px] text-amber-100">
                正在导出合辑，请不要关闭程序…
              </div>
            ) : null}

            <MontageExportSettings
              videoName={outputFilename}
              onVideoNameChange={(v) => {
                setFilenameTouched(true);
                setOutputFilename(v);
              }}
              outputDir={outputDir}
              onOutputDirChange={setOutputDir}
              bgmPath={bgmPath}
              onBgmChange={setBgmPath}
              introPath={introPath}
              onIntroChange={setIntroPath}
              outroPath={outroPath}
              onOutroChange={setOutroPath}
              draftName={draftName}
              onDraftNameChange={setDraftName}
              draftNamePlaceholder={stripMp4Extension(outputFilename) || "与视频名称同步"}
              onSaveDraft={() => void saveDraft()}
              savingDraft={savingDraft}
            />

            {lastExport?.ok ? (
              <MontageExportResult
                result={lastExport}
                themeId={selectedThemeId}
                clipCount={orderedIds.length}
                durationText={durationText}
                onCopyPath={(p) => void copyText(p)}
                onCopyShare={(t) => void copyText(t)}
              />
            ) : null}

            {lastExport && !lastExport.ok ? (
              <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-3 text-[11px] text-red-100">
                导出失败：{String(lastExport.err)}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
