import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import API, { API_BASE_URL } from "../api/api";
import { desktopBridge } from "../desktop/desktopBridge.js";
import { useMontageStore } from "../stores/montageStore";
import MontageDraftPanel from "./montage/MontageDraftPanel";
import MontageHistoryPanel from "./montage/MontageHistoryPanel";
import FfmpegRequiredDialog from "./FfmpegRequiredDialog";
import LiteCutExportProgressDialog from "../features/lite-cut/editor/LiteCutExportProgressDialog.jsx";
import { ChevronDown, Loader2, SlidersHorizontal } from "lucide-react";
import { useT } from "../i18n/useT.js";
import { formatMontageApiError, humanizeMontageError } from "../utils/formatMontageApiError.js";
import { ffmpegGateSubtitle } from "../utils/ffmpegGateMessages.js";
import { isFrameMeldImagePath, summarizeFrameMeldSources } from "../utils/framemeld.js";
import {
  MontageWorkbenchToolbar,
  MontageOrchestrationTimeline,
  MontageMaterialPoolCard,
} from "./montage/MontageWorkbenchPanels";
import { MontageStyleConsole } from "./montage/MontageStyleConsole";
import {
  sortClipsByStrategy,
  ensureMp4Filename,
  stripMp4Extension,
  getClipTitle,
  getClipDurationSeconds,
  formatMontageEstimate,
  getMontageTimelineVariant,
  derivePlayerAssetsFromClips,
} from "../utils/montageUtils";
import { DEFAULT_REL_EXPORT_DIR, FFMPEG_GATE_IDLE, FILTER_TABS, GLOBAL_TRANSITION_PRESET_SEC, GLOBAL_TRANSITION_TEMPLATES, TRANSITION_TYPES, buildGlobalTransitionStyleMap, buildTimestampMontageFilename, buildTransitionsPayload, clipBasename, clipMatchesLibraryFilter, dirnamePath, formatTransitionNodeLine, getEffectiveTransition, hydrateTransitionsFromApi, joinPathSegments, librarySearchMatch, montageToastFromError, normalizeTransition, transitionTypeLabel } from "./montage/montageWorkbenchUtils.js";

export default function MontageWorkbenchDrawer({ open, onClose, layout = "drawer" }) {
  const t = useT();
  const isPage = layout === "page";
  const navigate = useNavigate();
  const location = useLocation();
  const [ffmpegGate, setFfmpegGate] = useState(FFMPEG_GATE_IDLE);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [orderedIds, setOrderedIds] = useState([]);
  const [bgmPath, setBgmPath] = useState("");
  const [bgmStartSec, setBgmStartSec] = useState(0);
  const [introPath, setIntroPath] = useState("");
  const [introDuration, setIntroDuration] = useState(3);
  const [outroPath, setOutroPath] = useState("");
  const [outroDuration, setOutroDuration] = useState(3);
  const [framemeldEnabled, setFrameMeldEnabled] = useState(false);
  const [outputFilename, setOutputFilename] = useState(() => buildTimestampMontageFilename());
  const [outputDir, setOutputDir] = useState("");
  const outputDirTouchedRef = useRef(false);
  const persistedOutputDirRef = useRef(null);
  const exporting = useMontageStore((s) => s.exporting);
  const setExporting = useMontageStore((s) => s.setExporting);
  const lastExport = useMontageStore((s) => s.lastExport);
  const setLastExport = useMontageStore((s) => s.setLastExport);
  const markExportRead = useMontageStore((s) => s.markExportRead);
  const [projectId, setProjectId] = useState(null);
  const [draftName, setDraftName] = useState("");
  const [selectedThemeId, setSelectedThemeId] = useState("custom");
  const [bgmVolume, setBgmVolume] = useState(70);
  const [filterKey, setFilterKey] = useState("all");
  const [searchQ, setSearchQ] = useState("");
  const [poolControlsOpen, setPoolControlsOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [transitionByClipId, setTransitionByClipId] = useState({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [deleteClipPrompt, setDeleteClipPrompt] = useState(null);
  const [batchDeleteLibraryPrompt, setBatchDeleteLibraryPrompt] = useState(null);
  const [librarySelectedIds, setLibrarySelectedIds] = useState(() => new Set());
  const [selectedTimelineClipId, setSelectedTimelineClipId] = useState(null);
  const [timelineMultiSelectedIds, setTimelineMultiSelectedIds] = useState(() => new Set());
  const [transitionEdgeSourceId, setTransitionEdgeSourceId] = useState(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState(null);
  const draftDirtyBoot = useRef(true);
  const [playerAvatars, setPlayerAvatars] = useState({}); // { [player_key]: { avatar_path, avatar_url } }
  const [nameCardsEnabled, setNameCardsEnabled] = useState(false);
  const [exportJob, setExportJob] = useState(null);
  const [exportDialog, setExportDialog] = useState({ phase: "idle", result: null, error: "" });

  const toastTimer = useRef(null);

  const checkFfmpegGate = useCallback(async ({ showLoading = true } = {}) => {
    if (!open && !isPage) return;
    if (showLoading) {
      setFfmpegGate((prev) => ({ ...prev, loading: true }));
    }
    try {
      const { data } = await API.get("config/ffmpeg-check");
      if (data?.ok) {
        setFfmpegGate({
          loading: false,
          blocked: false,
          subtitle: "",
          message: "",
          framemeldAvailable: data?.framemeld_available === true,
        });
        return;
      }
      setFfmpegGate({
        loading: false,
        blocked: true,
        subtitle: ffmpegGateSubtitle(data?.reason, t),
        message: t("montage.ffmpegGateDefaultMessage"),
        framemeldAvailable: false,
      });
    } catch {
      setFfmpegGate({
        loading: false,
        blocked: true,
        subtitle: t("montage.ffmpegGateDetectFail"),
        message: t("montage.ffmpegGateConnectFail"),
        framemeldAvailable: false,
      });
    }
  }, [open, isPage, t]);

  useEffect(() => {
    void checkFfmpegGate();
  }, [checkFfmpegGate, location.pathname]);

  useEffect(() => {
    if (!open && !isPage) return;
    // Restoring the app or returning from a native file picker should refresh
    // FFmpeg capabilities without briefly covering the workbench.
    const onFocus = () => void checkFfmpegGate({ showLoading: false });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, isPage, checkFfmpegGate]);

  const showToast = useCallback((msg) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 3200);
  }, []);

  useEffect(() => {
    if (!open && !isPage) return undefined;
    let cancelled = false;
    void API.get("/config")
      .then(({ data }) => {
        if (cancelled) return;
        const savedDir = String(data?.montage_export_dir || "").trim();
        persistedOutputDirRef.current = savedDir;
        if (!outputDirTouchedRef.current) setOutputDir(savedDir);
      })
      .catch(() => {
        // Export can still use its automatic directory when config loading fails.
      });
    return () => {
      cancelled = true;
    };
  }, [open, isPage]);

  const persistOutputDir = useCallback(async (value) => {
    const normalized = String(value || "").trim().replace(/[/\\]+$/, "");
    if (persistedOutputDirRef.current === normalized) return true;
    try {
      await API.put("/config", { montage_export_dir: normalized });
      persistedOutputDirRef.current = normalized;
      return true;
    } catch {
      showToast(t("montage.toastExportDirPreferenceSaveFail"));
      return false;
    }
  }, [showToast, t]);

  const handleOutputDirChange = useCallback((value) => {
    outputDirTouchedRef.current = true;
    setOutputDir(value);
  }, []);

  const handleOutputDirCommit = useCallback(
    () => persistOutputDir(outputDir),
    [outputDir, persistOutputDir],
  );

  const handleOutputDirClear = useCallback(() => {
    outputDirTouchedRef.current = true;
    setOutputDir("");
    void persistOutputDir("");
  }, [persistOutputDir]);

  const handleOutputDirBrowse = useCallback(async () => {
    try {
      const selected = await desktopBridge?.chooseDirectory(
        outputDir.trim(),
        t("montage.consoleExportDirBrowse"),
      );
      const selectedDir = String(selected || "").trim().replace(/[/\\]+$/, "");
      if (!selectedDir) return;
      outputDirTouchedRef.current = true;
      setOutputDir(selectedDir);
      await persistOutputDir(selectedDir);
    } catch (e) {
      showToast(montageToastFromError(e, t) || t("montage.toastDirectoryPickerUnavailable"));
    }
  }, [outputDir, persistOutputDir, showToast, t]);

  const handlePlayerAvatarChange = useCallback((playerKey, avatarPath, avatarUrl) => {
    setPlayerAvatars((prev) => ({
      ...prev,
      [playerKey]: { ...(prev[playerKey] || {}), avatar_path: avatarPath, avatar_url: avatarUrl },
    }));
  }, []);

  const pickFile = useCallback(async (fileType, onResult) => {
    try {
      const { data } = await API.post("/file-picker", { file_type: fileType });
      if (data?.path) onResult(data.path);
    } catch (e) {
      showToast(montageToastFromError(e, t) || t("montage.toastFilepickerUnavailable"));
    }
  }, [showToast]);

  const loadClips = useCallback(async () => {
    setLoading(true);
    try {
      await API.post("/recorded-clips/purge-missing");
    } catch {
      // purge failure is non-fatal; continue to load list
    }
    try {
      const { data } = await API.get("/recorded-clips", { params: { limit: 500, offset: 0 } });
      setItems(data.items || []);
    } catch {
      setItems([]);
      showToast(t("montage.toastClipsLoadFail"));
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (!open && !isPage) return;
    if (ffmpegGate.loading || ffmpegGate.blocked) return;
    void loadClips();
  }, [open, loadClips, isPage, ffmpegGate.loading, ffmpegGate.blocked]);

  useEffect(() => {
    if (!open && !isPage) return;
    if (!lastExport?.unread || exporting) return;
    if (lastExport.ok) {
      showToast(t("montage.toastExportDone"));
    } else if (lastExport.err) {
      showToast(humanizeMontageError(lastExport.err, t));
    }
    markExportRead();
  }, [open, isPage, lastExport, exporting, showToast, markExportRead, t]);

  useEffect(() => {
    if (!open && !isPage) {
      setDeleteClipPrompt(null);
      setBatchDeleteLibraryPrompt(null);
    }
  }, [open, isPage]);

  useEffect(() => {
    if (selectedTimelineClipId != null && !orderedIds.includes(selectedTimelineClipId)) {
      setSelectedTimelineClipId(null);
    }
    setTimelineMultiSelectedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of prev) {
        if (!orderedIds.includes(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [orderedIds, selectedTimelineClipId]);

  useEffect(() => {
    if (transitionEdgeSourceId == null) return;
    const idx = orderedIds.indexOf(transitionEdgeSourceId);
    if (idx < 0 || idx >= orderedIds.length - 1) {
      setTransitionEdgeSourceId(null);
    }
  }, [orderedIds, transitionEdgeSourceId]);

  useEffect(() => {
    if (draftDirtyBoot.current) {
      draftDirtyBoot.current = false;
      return;
    }
    setDraftDirty(true);
  }, [
    orderedIds,
    transitionByClipId,
    bgmPath,
    bgmStartSec,
    introPath,
    introDuration,
    outroPath,
    outroDuration,
    outputFilename,
    selectedThemeId,
    draftName,
    bgmVolume,
    playerAvatars,
    nameCardsEnabled,
    framemeldEnabled,
  ]);

  const byId = useMemo(() => {
    const m = new Map();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  const orderedIdSet = useMemo(() => new Set(orderedIds), [orderedIds]);

  const orderedClips = useMemo(() => orderedIds.map((id) => byId.get(id)).filter(Boolean), [orderedIds, byId]);

  const supplementalFrameMeldPaths = useMemo(
    () => [introPath, outroPath]
      .map((value) => String(value || "").trim())
      .filter((value) => value && !isFrameMeldImagePath(value)),
    [introPath, outroPath],
  );
  const supplementalFrameMeldKey = useMemo(
    () => JSON.stringify(supplementalFrameMeldPaths),
    [supplementalFrameMeldPaths],
  );
  const [supplementalFrameMeldProbe, setSupplementalFrameMeldProbe] = useState({ key: "[]", items: [] });

  useEffect(() => {
    let cancelled = false;
    if (supplementalFrameMeldPaths.length === 0) {
      setSupplementalFrameMeldProbe({ key: supplementalFrameMeldKey, items: [] });
      return () => {
        cancelled = true;
      };
    }

    const pendingItems = supplementalFrameMeldPaths.map((path) => ({ path, fps: null }));
    setSupplementalFrameMeldProbe({ key: supplementalFrameMeldKey, items: pendingItems });
    const timerId = window.setTimeout(() => {
      void API.post("/montage/media-fps", { paths: supplementalFrameMeldPaths })
        .then(({ data }) => {
          if (cancelled) return;
          const probedByPath = new Map(
            (Array.isArray(data?.items) ? data.items : []).map((item) => [String(item?.path || ""), item]),
          );
          setSupplementalFrameMeldProbe({
            key: supplementalFrameMeldKey,
            items: supplementalFrameMeldPaths.map((path) => ({
              path,
              fps: probedByPath.get(path)?.fps ?? null,
            })),
          });
        })
        .catch(() => {
          if (!cancelled) {
            setSupplementalFrameMeldProbe({ key: supplementalFrameMeldKey, items: pendingItems });
          }
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [supplementalFrameMeldKey, supplementalFrameMeldPaths]);

  const supplementalFrameMeldItems = useMemo(
    () => supplementalFrameMeldProbe.key === supplementalFrameMeldKey
      ? supplementalFrameMeldProbe.items
      : supplementalFrameMeldPaths.map((path) => ({ path, fps: null })),
    [supplementalFrameMeldKey, supplementalFrameMeldPaths, supplementalFrameMeldProbe],
  );
  const framemeldSourceSummary = useMemo(
    () => summarizeFrameMeldSources([...orderedClips, ...supplementalFrameMeldItems]),
    [orderedClips, supplementalFrameMeldItems],
  );
  const framemeldCanEnable = !ffmpegGate.loading
    && ffmpegGate.framemeldAvailable
    && framemeldSourceSummary.compatible;
  const effectiveFrameMeldEnabled = framemeldCanEnable && framemeldEnabled;

  useEffect(() => {
    if (framemeldEnabled && !framemeldCanEnable) {
      setFrameMeldEnabled(false);
    }
  }, [framemeldCanEnable, framemeldEnabled]);

  const handleFrameMeldEnabledChange = useCallback((enabled) => {
    setFrameMeldEnabled(Boolean(enabled) && framemeldCanEnable);
  }, [framemeldCanEnable]);

  const unknownDurationHint = useMemo(() => {
    if (orderedClips.length === 0) return null;
    const anyUnknown = orderedClips.some((c) => getClipDurationSeconds(c) == null);
    return anyUnknown ? t("montage.unknownDurationHint") : null;
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
      if (!clipMatchesLibraryFilter(clip, filterKey, orderedIdSet)) return false;
      return librarySearchMatch(clip, searchQ);
    });
  }, [items, filterKey, searchQ, orderedIdSet]);

  const transitionsPayload = useMemo(
    () => buildTransitionsPayload(orderedIds, transitionByClipId),
    [orderedIds, transitionByClipId],
  );

  const orderedIdsAsStrings = useMemo(() => orderedIds.map(String), [orderedIds]);

  const effectiveOutputDir = useMemo(() => {
    const trimmed = outputDir.trim();
    if (trimmed) return trimmed.replace(/[/\\]+$/, "");
    const firstPath = orderedClips.find((c) => c?.output_path)?.output_path || items.find((c) => c?.output_path)?.output_path;
    if (firstPath) {
      const base = dirnamePath(firstPath);
      return joinPathSegments(base, ...DEFAULT_REL_EXPORT_DIR.split("/"));
    }
    return "";
  }, [outputDir, orderedClips, items]);

  const addToSequence = useCallback((id) => {
    setOrderedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const addFilteredToSequence = useCallback(() => {
    let added = 0;
    setOrderedIds((prev) => {
      const set = new Set(prev);
      for (const c of filteredLibrary) {
        if (!set.has(c.id)) added += 1;
        set.add(c.id);
      }
      return Array.from(set);
    });
    if (added > 0) showToast(t("montage.toastAddedFiltered", { added, total: filteredLibrary.length }));
    else showToast(t("montage.toastAllFilteredJoined"));
  }, [filteredLibrary, showToast]);

  const removeFromSequence = useCallback((id) => {
    setOrderedIds((prev) => prev.filter((x) => x !== id));
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      delete next[String(id)];
      return next;
    });
    setTimelineMultiSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const confirmDeleteLibraryClip = useCallback(async () => {
    const clip = deleteClipPrompt;
    if (!clip) return;
    try {
      await API.delete(`/recorded-clips/${clip.id}`);
      setOrderedIds((prev) => prev.filter((x) => x !== clip.id));
      setTransitionByClipId((prev) => {
        const next = { ...prev };
        delete next[String(clip.id)];
        return next;
      });
      setItems((prev) => prev.filter((x) => x.id !== clip.id));
      setLibrarySelectedIds((prev) => {
        if (!prev.has(clip.id)) return prev;
        const next = new Set(prev);
        next.delete(clip.id);
        return next;
      });
      setTimelineMultiSelectedIds((prev) => {
        if (!prev.has(clip.id)) return prev;
        const next = new Set(prev);
        next.delete(clip.id);
        return next;
      });
      setDeleteClipPrompt(null);
      showToast(t("montage.toastClipDeleted"));
    } catch (e) {
      showToast(montageToastFromError(e, t) || t("montage.toastClipDeleteFail"));
    }
  }, [deleteClipPrompt, showToast, t]);

  const openBatchDeleteLibraryPrompt = useCallback(() => {
    const clips = items.filter((c) => librarySelectedIds.has(c.id));
    if (!clips.length) {
      showToast(t("montage.toastNoneToDelete"));
      return;
    }
    setDeleteClipPrompt(null);
    setBatchDeleteLibraryPrompt(clips);
  }, [items, librarySelectedIds, showToast, t]);

  const confirmBatchDeleteLibraryClips = useCallback(async () => {
    const clips = batchDeleteLibraryPrompt;
    if (!clips?.length) return;
    const ids = clips.map((c) => c.id);
    try {
      const { data } = await API.post("/recorded-clips/batch-delete", { ids });
      const deletedList = Array.isArray(data?.deleted) ? data.deleted : [];
      const deletedIds = new Set(deletedList.map((d) => d.id));
      const notFound = Array.isArray(data?.not_found) ? data.not_found : [];
      setOrderedIds((prev) => prev.filter((id) => !deletedIds.has(id)));
      setTransitionByClipId((prev) => {
        const next = { ...prev };
        for (const id of deletedIds) delete next[String(id)];
        return next;
      });
      setItems((prev) => prev.filter((x) => !deletedIds.has(x.id)));
      setLibrarySelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
      setTimelineMultiSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
      setBatchDeleteLibraryPrompt(null);
      const n = deletedIds.size;
      if (notFound.length) {
        showToast(t("montage.toastBatchDeletedWithMissing", { n, missing: notFound.length }));
      } else {
        showToast(t("montage.toastBatchDeleted", { n }));
      }
    } catch (e) {
      showToast(montageToastFromError(e, t) || t("montage.toastBatchDeleteFail"));
    }
  }, [batchDeleteLibraryPrompt, showToast, t]);

  const handleSort = useCallback(
    (strategy) => {
      const clips = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      const sorted = sortClipsByStrategy(clips, strategy);
      setOrderedIds(sorted.map((c) => c.id));
    },
    [orderedIds, byId],
  );

  const handleReverseOrder = useCallback(() => {
    if (orderedIds.length < 2) return;
    setOrderedIds((prev) => [...prev].reverse());
    showToast(t("montage.toastReverseOrder"));
  }, [orderedIds.length, showToast, t]);

  const applyGlobalTransitionTemplate = useCallback(
    (styleId, label) => {
      if (orderedIds.length < 2) {
        showToast(t("montage.toastNeedTwoForTransition"));
        return;
      }
      const built = buildGlobalTransitionStyleMap(styleId, orderedIds);
      setTransitionByClipId((prev) => {
        const cleared = { ...prev };
        for (const id of orderedIds) delete cleared[String(id)];
        return { ...cleared, ...built };
      });
      showToast(t("montage.toastTemplateApplied", { label }));
    },
    [orderedIds, showToast, t],
  );

  const applyGlobalTransitionType = useCallback(
    (type) => {
      if (orderedIds.length < 2) {
        showToast(t("montage.toastNeedTwoForTransition"));
        return;
      }
      const dur = type === "none" ? 0 : Math.min(1.5, GLOBAL_TRANSITION_PRESET_SEC);
      setTransitionByClipId((prev) => {
        const cleared = { ...prev };
        for (const id of orderedIds) delete cleared[String(id)];
        const next = { ...cleared };
        for (let i = 0; i < orderedIds.length - 1; i++) {
          const key = String(orderedIds[i]);
          next[key] = normalizeTransition({ type, duration: dur });
        }
        return next;
      });
      showToast(t("montage.toastTransitionTypeApplied", { label: transitionTypeLabel(type, t) }));
    },
    [orderedIds, showToast, t],
  );

  const applyGlobalDurationToAll = useCallback(() => {
    if (orderedIds.length < 2) {
      showToast(t("montage.toastNeedTwo"));
      return;
    }
    const sec = Math.min(1.5, GLOBAL_TRANSITION_PRESET_SEC);
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      for (let i = 0; i < orderedIds.length - 1; i++) {
        const id = orderedIds[i];
        const cur = getEffectiveTransition(prev, id);
        if (cur.type === "none") continue;
        next[String(id)] = normalizeTransition({ ...cur, duration: sec });
      }
      return next;
    });
    showToast(t("montage.toastUnifiedDuration"));
  }, [orderedIds, showToast, t]);

  const applyRandomTransitions = useCallback(() => {
    if (orderedIds.length < 2) {
      showToast(t("montage.toastNeedTwo"));
      return;
    }
    const pool = ["cut", "fade", "flash", "dip_black", "zoom"];
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      for (let i = 0; i < orderedIds.length - 1; i++) {
        const id = orderedIds[i];
        const type = pool[Math.floor(Math.random() * pool.length)];
        const duration = Math.round((0.12 + Math.random() * 0.38) * 1000) / 1000;
        next[String(id)] = normalizeTransition({ type, duration });
      }
      return next;
    });
    showToast(t("montage.toastRandomTransitions"));
  }, [orderedIds, showToast, t]);

  const applyKillTypeTransitions = useCallback(() => {
    if (orderedIds.length < 2) {
      showToast(t("montage.toastNeedTwo"));
      return;
    }
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      for (let i = 0; i < orderedIds.length - 1; i++) {
        const id = orderedIds[i];
        const clip = byId.get(id);
        const v = getMontageTimelineVariant(clip);
        let type = "cut";
        let duration = 0.2;
        if (v === "fail") {
          type = "dip_black";
          duration = 0.45;
        } else if (v === "ace" || v === "multikill") {
          type = "flash";
          duration = 0.22;
        } else if (v === "highlight") {
          type = "fade";
          duration = 0.35;
        } else if (v === "timeline") {
          type = "cut";
          duration = 0.22;
        } else if (v === "compilation") {
          type = "zoom";
          duration = 0.3;
        } else {
          type = "fade";
          duration = 0.28;
        }
        next[String(id)] = normalizeTransition({ type, duration });
      }
      return next;
    });
    showToast(t("montage.toastKillTypeTransitions"));
  }, [orderedIds, byId, showToast, t]);

  const validateExport = useCallback(() => {
    if (orderedIds.length < 1) {
      return t("montage.exportValidNoClips");
    }
    const name = outputFilename.trim();
    if (!name) {
      return t("montage.exportValidNoFilename");
    }
    if (!effectiveOutputDir) {
      return t("montage.exportValidNoDir");
    }
    return null;
  }, [orderedIds.length, outputFilename, effectiveOutputDir, t]);

  const saveDraft = useCallback(async (nameOverride = "") => {
    const requestedName = String(nameOverride || "").trim();
    const effectiveName =
      requestedName || draftName.trim() || stripMp4Extension(outputFilename).trim() || outputFilename.trim();
    if (!effectiveName) {
      showToast(t("montage.toastNeedDraftName"));
      return false;
    }
    setSavingDraft(true);
    try {
      const playerList = derivePlayerAssetsFromClips(orderedClips);
      const playerAvatarsPayload = playerList.map((p) => ({
        player_key: p.player_key,
        steamid64: p.steamid64 || null,
        player_name: p.display_name || "",
        avatar_path: playerAvatars[p.player_key]?.avatar_path || null,
        enabled: true,
      }));
      const { data } = await API.post("/montage/projects", {
        project_id: projectId,
        name: effectiveName,
        recorded_clip_ids: orderedIds,
        bgm_path: bgmPath.trim() || null,
        bgm_start_sec: bgmStartSec > 0 ? bgmStartSec : undefined,
        intro_path: introPath.trim() || null,
        intro_image_duration: introDuration !== 3 ? introDuration : undefined,
        outro_path: outroPath.trim() || null,
        outro_image_duration: outroDuration !== 3 ? outroDuration : undefined,
        output_filename: ensureMp4Filename(outputFilename.trim()) || "montage_export.mp4",
        transitions: transitionsPayload,
        theme_id: selectedThemeId,
        bgm_volume: bgmVolume / 100,
        player_avatars: playerAvatarsPayload,
        name_cards_enabled: nameCardsEnabled,
        framemeld_enabled: effectiveFrameMeldEnabled,
      });
      setProjectId(data.id);
      if (data?.body?.transitions && typeof data.body.transitions === "object") {
        setTransitionByClipId(hydrateTransitionsFromApi(data.body.transitions));
      }
      if (data?.body?.theme_id != null && String(data.body.theme_id).trim()) {
        setSelectedThemeId(String(data.body.theme_id).trim());
      }
      const bv = data?.body?.bgm_volume;
      if (bv != null && Number.isFinite(Number(bv))) {
        setBgmVolume(Math.round(Number(bv) * 100));
      }
      if (Array.isArray(data?.body?.player_avatars)) {
        const restored = {};
        for (const pa of data.body.player_avatars) {
          if (pa?.player_key) {
            const filename = String(pa.avatar_path || "")
              .replace(/\\/g, "/")
              .split("/")
              .pop();
            restored[pa.player_key] = {
              avatar_path: pa.avatar_path || null,
              avatar_url: filename
                ? `${API_BASE_URL}/api/montage/avatars/${filename}`
                : null,
            };
          }
        }
        setPlayerAvatars(restored);
      }
      if (typeof data?.body?.name_cards_enabled === "boolean") {
        setNameCardsEnabled(data.body.name_cards_enabled);
      }
      if (typeof data?.body?.framemeld_enabled === "boolean") {
        setFrameMeldEnabled(Boolean(data.body.framemeld_enabled) && framemeldCanEnable);
      }
      if (requestedName) setDraftName(requestedName);
      setDraftDirty(false);
      setLastDraftSavedAt(Date.now());
      showToast(t("montage.toastDraftSaved"));
      return true;
    } catch (e) {
      showToast(montageToastFromError(e, t) || t("montage.toastDraftSaveFail"));
      return false;
    } finally {
      setSavingDraft(false);
    }
  }, [
    projectId,
    draftName,
    outputFilename,
    orderedIds,
    orderedClips,
    bgmPath,
    bgmStartSec,
    introPath,
    introDuration,
    outroPath,
    outroDuration,
    showToast,
    transitionsPayload,
    selectedThemeId,
    bgmVolume,
    playerAvatars,
    nameCardsEnabled,
    effectiveFrameMeldEnabled,
    framemeldCanEnable,
    t,
  ]);

  const loadDraft = useCallback(async (draft) => {
    const body = draft?.body && typeof draft.body === "object" ? draft.body : null;
    if (!body) {
      showToast(t("montage.draftsOpenFailed"));
      return false;
    }
    if (draftDirty && !window.confirm(t("montage.draftsReplaceConfirm"))) return false;

    const draftClipIds = Array.isArray(body.recorded_clip_ids)
      ? body.recorded_clip_ids
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
      : [];
    const uniqueClipIds = [...new Set(draftClipIds)];
    const availableClipIds = uniqueClipIds.filter((id) => byId.has(id));
    const missingClipCount = uniqueClipIds.length - availableClipIds.length;
    const nextAvatars = {};
    if (Array.isArray(body.player_avatars)) {
      for (const avatar of body.player_avatars) {
        if (!avatar?.player_key) continue;
        const filename = String(avatar.avatar_path || "")
          .replace(/\\/g, "/")
          .split("/")
          .pop();
        nextAvatars[avatar.player_key] = {
          avatar_path: avatar.avatar_path || null,
          avatar_url: filename ? `${API_BASE_URL}/api/montage/avatars/${filename}` : null,
        };
      }
    }
    const numberOr = (value, fallback, minimum = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
    };

    // Applying a saved project changes many controlled fields at once. Skip the
    // dirty-state effect for this render so the freshly opened draft is clean.
    draftDirtyBoot.current = true;
    setProjectId(Number(draft.id));
    setDraftName(String(draft.name || ""));
    setOrderedIds(availableClipIds);
    setTransitionByClipId(hydrateTransitionsFromApi(body.transitions));
    setBgmPath(String(body.bgm_path || ""));
    setBgmStartSec(numberOr(body.bgm_start_sec, 0));
    setIntroPath(String(body.intro_path || ""));
    setIntroDuration(numberOr(body.intro_image_duration, 3, 1));
    setOutroPath(String(body.outro_path || ""));
    setOutroDuration(numberOr(body.outro_image_duration, 3, 1));
    setOutputFilename(String(body.output_filename || "montage_export.mp4"));
    setSelectedThemeId(String(body.theme_id || "custom"));
    setBgmVolume(Math.round(Math.max(0, Math.min(2, numberOr(body.bgm_volume, 0.7))) * 100));
    setPlayerAvatars(nextAvatars);
    setNameCardsEnabled(Boolean(body.name_cards_enabled));
    setFrameMeldEnabled(Boolean(body.framemeld_enabled));
    setSelectedTimelineClipId(null);
    setTimelineMultiSelectedIds(new Set());
    setTransitionEdgeSourceId(null);
    setLastExport(null);
    setDraftDirty(false);
    const updatedAt = Date.parse(String(draft.updated_at || ""));
    setLastDraftSavedAt(Number.isFinite(updatedAt) ? updatedAt : Date.now());

    showToast(
      missingClipCount > 0
        ? t("montage.draftsLoadedWithMissing", { n: missingClipCount })
        : t("montage.draftsLoaded"),
    );
    return true;
  }, [byId, draftDirty, setLastExport, showToast, t]);

  const runExport = useCallback(async () => {
    const err = validateExport();
    if (err) {
      showToast(err);
      return;
    }
    const dir = effectiveOutputDir;
    const fn = ensureMp4Filename(outputFilename.trim());
    const sep = dir.includes("\\") ? "\\" : "/";
    const outPath = dir.replace(/[/\\]+$/, "") + sep + fn;
    await persistOutputDir(outputDir);
    setExporting(true);
    setLastExport(null);
    setExportJob(null);
    setExportDialog({
      phase: "running",
      result: { progress: 0, stage: "queued", output_path: outPath },
      error: "",
    });
    try {
      const playerList = derivePlayerAssetsFromClips(orderedClips);
      const playerAvatarsPayload = playerList.map((p) => ({
        player_key: p.player_key,
        steamid64: p.steamid64 || null,
        player_name: p.display_name || "",
        avatar_path: playerAvatars[p.player_key]?.avatar_path || null,
        enabled: true,
      }));
      const { data } = await API.post("/montage/export", {
        project_id: projectId,
        recorded_clip_ids: orderedIds.length ? orderedIds : undefined,
        ordered_ids: orderedIdsAsStrings,
        transitions: transitionsPayload,
        bgm_path: bgmPath.trim() || null,
        ...(bgmPath.trim() ? { bgm_volume: bgmVolume / 100 } : {}),
        ...(bgmPath.trim() && bgmStartSec > 0 ? { bgm_start_sec: bgmStartSec } : {}),
        intro_path: introPath.trim() || null,
        ...(introPath.trim() ? { intro_image_duration: introDuration } : {}),
        outro_path: outroPath.trim() || null,
        ...(outroPath.trim() ? { outro_image_duration: outroDuration } : {}),
        output_path: outPath,
        theme_id: selectedThemeId,
        player_avatars: playerAvatarsPayload,
        name_cards_enabled: nameCardsEnabled,
        framemeld_enabled: effectiveFrameMeldEnabled,
      });
      const next = { ...data, output_path: data?.output_path || outPath };
      setExportJob(next);
      setExportDialog({ phase: "running", result: next, error: "" });
    } catch (e) {
      const errMsg = formatMontageApiError(e, t, t("montage.exportErrorGeneric"));
      setLastExport({ ok: false, err: errMsg });
      setExportDialog({ phase: "error", result: null, error: errMsg });
      showToast(errMsg);
      setExporting(false);
    }
  }, [
    validateExport,
    projectId,
    orderedIds,
    orderedClips,
    orderedIdsAsStrings,
    transitionsPayload,
    bgmPath,
    bgmStartSec,
    introPath,
    introDuration,
    outroPath,
    outroDuration,
    effectiveOutputDir,
    outputDir,
    outputFilename,
    persistOutputDir,
    selectedThemeId,
    bgmVolume,
    playerAvatars,
    nameCardsEnabled,
    effectiveFrameMeldEnabled,
    showToast,
    t,
  ]);

  useEffect(() => {
    if (!exporting || !exportJob?.export_id) return undefined;
    let stopped = false;
    let intervalId = null;

    const poll = async () => {
      try {
        const { data: next } = await API.get(`/montage/exports/${encodeURIComponent(String(exportJob.export_id))}`);
        if (stopped) return;
        setExportJob(next);
        if (next?.status === "done") {
          setExporting(false);
          setLastExport({ ok: true, ...next });
          setExportDialog({ phase: "done", result: next, error: "" });
          showToast(t("montage.toastExportComplete"));
          return;
        }
        if (next?.status === "error") {
          const errMsg = humanizeMontageError(next?.error, t);
          setExporting(false);
          setLastExport({ ok: false, err: errMsg });
          setExportDialog({ phase: "error", result: next, error: errMsg });
          showToast(errMsg);
          return;
        }
        if (next?.status === "cancelled") {
          setExporting(false);
          setLastExport(null);
          setExportDialog({ phase: "cancelled", result: next, error: "" });
          return;
        }
        setExportDialog({ phase: "running", result: next, error: "" });
      } catch (e) {
        if (stopped) return;
        const errMsg = formatMontageApiError(e, t, t("montage.exportErrorGeneric"));
        setExporting(false);
        setLastExport({ ok: false, err: errMsg });
        setExportDialog({ phase: "error", result: null, error: errMsg });
        showToast(errMsg);
      }
    };

    void poll();
    intervalId = window.setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [exporting, exportJob?.export_id, setExporting, setLastExport, showToast, t]);

  const handleCancelExport = useCallback(async () => {
    const exportId = exportJob?.export_id || exportDialog.result?.export_id;
    if (!exportId) return;
    try {
      const { data: next } = await API.post(
        `/montage/exports/${encodeURIComponent(String(exportId))}/cancel`,
      );
      setExportJob(next);
      setExportDialog({ phase: "running", result: next, error: "" });
    } catch (e) {
      const errMsg = formatMontageApiError(e, t, t("montage.exportErrorGeneric"));
      showToast(errMsg);
    }
  }, [exportDialog.result?.export_id, exportJob?.export_id, showToast, t]);

  const copyText = useCallback(
    async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(t("montage.toastCopied"));
      } catch {
        showToast(t("montage.toastCopyFail"));
      }
    },
    [showToast, t],
  );

  const clearTimeline = useCallback(() => {
    setOrderedIds([]);
    setTransitionByClipId({});
    setSelectedTimelineClipId(null);
    setTimelineMultiSelectedIds(new Set());
    setTransitionEdgeSourceId(null);
  }, []);

  const removeTimelineMulti = useCallback(() => {
    if (timelineMultiSelectedIds.size === 0) return;
    const drop = new Set(timelineMultiSelectedIds);
    setOrderedIds((prev) => prev.filter((id) => !drop.has(id)));
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      for (const id of drop) delete next[String(id)];
      return next;
    });
    setTimelineMultiSelectedIds(new Set());
  }, [timelineMultiSelectedIds]);

  const onOrchestrationRowClick = useCallback((e, id) => {
    setTransitionEdgeSourceId(null);
    if (e.ctrlKey || e.metaKey) {
      setTimelineMultiSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelectedTimelineClipId(id);
      return;
    }
    setTimelineMultiSelectedIds((prev) => {
      if (prev.size === 1 && prev.has(id)) return new Set();
      return new Set([id]);
    });
    setSelectedTimelineClipId((prev) => (prev === id ? null : id));
  }, []);

  const shiftTimelineSelection = useCallback(
    (delta) => {
      setOrderedIds((prev) => {
        const sel = timelineMultiSelectedIds;
        if (sel.size === 0) return prev;
        const indices = prev.map((id, i) => (sel.has(id) ? i : -1)).filter((i) => i >= 0);
        if (!indices.length) return prev;
        const sortedIdx = [...indices].sort((a, b) => a - b);
        const contiguous = sortedIdx.every((v, j, arr) => j === 0 || v === arr[j - 1] + 1);
        if (!contiguous) {
          queueMicrotask(() => showToast(t("montage.toastNeedMoreForMove")));
          return prev;
        }
        const blockStart = sortedIdx[0];
        const blockLen = sortedIdx.length;
        const blockEnd = sortedIdx[sortedIdx.length - 1];
        if (delta < 0 && blockStart === 0) return prev;
        if (delta > 0 && blockEnd >= prev.length - 1) return prev;
        const block = prev.slice(blockStart, blockStart + blockLen);
        const without = [...prev.slice(0, blockStart), ...prev.slice(blockStart + blockLen)];
        if (delta < 0) {
          const insertAt = blockStart - 1;
          return [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)];
        }
        const insertAt = blockStart;
        return [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)];
      });
    },
    [timelineMultiSelectedIds, showToast, t],
  );

  const onDragStart = useCallback((e, id) => {
    setDragId(id);
    e.dataTransfer.setData("text/plain", String(id));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const onDragEnd = useCallback(() => setDragId(null), []);

  const onDragOverItem = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  /** Timeline rail / canvas drop: library → insert; timeline → reorder */
  const onTimelineCanvasDrop = useCallback((draggedId, targetId) => {
    if (!Number.isFinite(draggedId)) return;
    const onTimeline = orderedIds.includes(draggedId);
    if (!onTimeline) {
      setOrderedIds((prev) => {
        if (prev.includes(draggedId)) return prev;
        if (targetId == null) return [...prev, draggedId];
        const next = [...prev];
        const ti = next.indexOf(targetId);
        if (ti < 0) return [...prev, draggedId];
        next.splice(ti, 0, draggedId);
        return next;
      });
      setDragId(null);
      showToast(t("montage.toastAddedToTimeline"));
      return;
    }
    if (draggedId === targetId) return;
    setOrderedIds((prev) => {
      const next = prev.filter((x) => x !== draggedId);
      if (targetId == null) return [...next, draggedId];
      const ti = next.indexOf(targetId);
      if (ti < 0) return [...next, draggedId];
      next.splice(ti, 0, draggedId);
      return next;
    });
    setDragId(null);
  }, [orderedIds, showToast, t]);

  const patchTransition = useCallback((sourceClipId, patch) => {
    setTransitionByClipId((prev) => ({
      ...prev,
      [String(sourceClipId)]: normalizeTransition({
        ...getEffectiveTransition(prev, sourceClipId),
        ...patch,
      }),
    }));
  }, []);

  const durationText = formatMontageEstimate(totalKnownSeconds, orderedIds.length, t);

  // Translated versions of constant arrays (labels resolved via t)
  const transitionTypeOptions = useMemo(
    () => TRANSITION_TYPES.map((tr) => ({ id: tr.id, label: t(tr.labelKey) })),
    [t],
  );
  const globalTransitionTemplates = useMemo(
    () => GLOBAL_TRANSITION_TEMPLATES.map((tpl) => ({ id: tpl.id, label: t(tpl.labelKey) })),
    [t],
  );

  const exportReady = useMemo(() => {
    if (orderedIds.length < 1) return false;
    if (!String(outputFilename || "").trim()) return false;
    if (!effectiveOutputDir) return false;
    return true;
  }, [orderedIds.length, outputFilename, effectiveOutputDir]);

  const fullOutputPathPreview = useMemo(() => {
    const dir = effectiveOutputDir;
    const fn = ensureMp4Filename(String(outputFilename || "").trim());
    if (!dir || !fn) return "";
    const sep = String(dir).includes("\\") ? "\\" : "/";
    return String(dir).replace(/[/\\]+$/, "") + sep + fn;
  }, [effectiveOutputDir, outputFilename]);

  const displayMontageTitle = useMemo(
    () => draftName.trim() || stripMp4Extension(outputFilename).trim() || t("montage.untitledMontage"),
    [draftName, outputFilename, t],
  );

  const autosaveStatusLabel = useMemo(() => {
    if (draftDirty) return t("montage.autosaveDirty");
    if (lastDraftSavedAt) {
      try {
        return t("montage.autosaveSavedAt", { time: new Date(lastDraftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
      } catch {
        return t("montage.autosaveSaved");
      }
    }
    return t("montage.autosaveReady");
  }, [draftDirty, lastDraftSavedAt, t]);

  const libraryPoolStats = useMemo(() => {
    let known = 0;
    let sum = 0;
    for (const c of filteredLibrary) {
      const d = getClipDurationSeconds(c);
      if (d != null) {
        sum += d;
        known += 1;
      }
    }
    const n = filteredLibrary.length;
    return {
      count: n,
      totalLabel: formatMontageEstimate(sum, n, t),
      avgLabel: known > 0 ? `${(sum / known).toFixed(1)}s` : "—",
    };
  }, [filteredLibrary]);

  const onLibraryCardMultiClick = useCallback((e, id) => {
    if (e.ctrlKey || e.metaKey) {
      setLibrarySelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setLibrarySelectedIds((prev) => {
      if (prev.size === 1 && prev.has(id)) return new Set();
      return new Set([id]);
    });
    setSelectedTimelineClipId(null);
  }, []);

  const selectAllFilteredLibrary = useCallback(() => {
    if (filteredLibrary.length === 0) return;
    setLibrarySelectedIds(new Set(filteredLibrary.map((c) => c.id)));
    setSelectedTimelineClipId(null);
  }, [filteredLibrary]);

  const addSelectionToTimeline = useCallback(() => {
    const ids = librarySelectedIds.size > 0 ? [...librarySelectedIds] : [];
    if (!ids.length) {
      showToast(t("montage.toastSelectBeforeBatch"));
      return;
    }
    let added = 0;
    setOrderedIds((prev) => {
      const s = new Set(prev);
      for (const id of ids) {
        if (!s.has(id)) added += 1;
        s.add(id);
      }
      return Array.from(s);
    });
    showToast(added ? t("montage.toastAddedBatch", { n: added }) : t("montage.toastAllBatchAlready"));
  }, [librarySelectedIds, showToast, t]);

  if (!open && !isPage) return null;

  const exportOk = lastExport?.ok && lastExport.output_path;
  const exportDirForButton = exportOk ? dirnamePath(lastExport.output_path) : "";

  const shellClass = isPage
    ? "montage-workbench-shell flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-2 overflow-hidden"
    : "flex h-full w-[min(1680px,99vw)] flex-col border-l border-cs2-border bg-cs2-bg-card shadow-2xl";

  const inner = (
    <>
      {ffmpegGate.loading ? (
        <div
          className="fixed inset-0 z-[125] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          aria-busy="true"
          aria-label={t("montage.ffmpegChecking")}
        >
          <div className="flex items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-card px-4 py-3 text-sm text-cs2-text-secondary">
            <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />
            {t("montage.ffmpegChecking")}
          </div>
        </div>
      ) : null}
      {ffmpegGate.blocked ? (
        <FfmpegRequiredDialog
          subtitle={ffmpegGate.subtitle}
          message={ffmpegGate.message}
          onGoSettings={() => navigate("/settings?tab=video")}
        />
      ) : null}
    <div className={shellClass}>
        <MontageWorkbenchToolbar
          isPage={isPage}
          montageTitle={displayMontageTitle}
          subtitle={t("montage.workbenchSubtitle")}
          autosaveLabel={autosaveStatusLabel}
          poolSelectedCount={librarySelectedIds.size}
          poolStats={libraryPoolStats}
          onClose={onClose}
          onAutoSort={() => handleSort("highlight_first")}
          onTimelineSort={() => handleSort("timeline")}
          onRhythmSort={() => handleSort("rhythm")}
          onRandomSort={() => handleSort("random")}
          onReverseOrder={handleReverseOrder}
          onSaveDraft={saveDraft}
          savingDraft={savingDraft}
          saveDraftNameFallback={displayMontageTitle}
          onHistory={() => setHistoryOpen(true)}
          onDrafts={() => setDraftsOpen(true)}
        />
        <MontageHistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
        <MontageDraftPanel
          open={draftsOpen}
          onClose={() => setDraftsOpen(false)}
          onOpenDraft={loadDraft}
          onDeleteDraft={(deletedId) => {
            if (Number(deletedId) === projectId) setProjectId(null);
          }}
        />

        <div
          data-testid="montage-workbench-content-card"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden"
        >
          {toast ? (
            <div className="border-b border-emerald-500/30 bg-cs2-emerald-surface px-4 py-2.5 text-center text-xs font-medium text-cs2-emerald-on-surface">
              {toast}
            </div>
          ) : null}
          <div className="montage-workbench-grid min-h-0 min-w-0 flex-1 gap-2">
            {/* 左侧素材池 */}
            <aside className="montage-workbench-panel montage-workbench-pool flex min-h-0 min-w-0 flex-col gap-2">
              <div data-testid="montage-pool-filters-card" className="shrink-0 overflow-hidden rounded-[10px] border border-cs2-border bg-cs2-bg-card">
                <button
                  type="button"
                  data-testid="montage-pool-controls-toggle"
                  aria-expanded={poolControlsOpen}
                  onClick={() => setPoolControlsOpen((value) => !value)}
                  className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:bg-cs2-bg-hover"
                >
                  <span className="flex min-w-0 items-center gap-2 text-xs font-bold text-cs2-text-primary">
                    <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-cs2-accent" />
                    <span className="truncate">{t("montage.poolControlsTitle")}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[10px] text-cs2-text-muted">{t("montage.poolControlsCount", { n: filteredLibrary.length })}</span>
                    <ChevronDown className={`h-4 w-4 text-cs2-text-muted transition-transform ${poolControlsOpen ? "rotate-180" : ""}`} />
                  </span>
                </button>
                {poolControlsOpen ? (
                  <div data-testid="montage-pool-controls-body" className="space-y-3 border-t border-cs2-border p-3.5">
                <div className="flex flex-wrap gap-1.5">
                  {FILTER_TABS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFilterKey(f.id)}
                      className={`rounded-lg border px-3 py-1 text-xs font-medium transition-all ${
                        filterKey === f.id
                          ? "border-cs2-accent bg-cs2-accent-soft text-cs2-accent font-bold shadow-sm"
                          : "border-cs2-border-subtle bg-cs2-surface-1 text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary"
                      }`}
                    >
                      {t(f.labelKey)}
                    </button>
                  ))}
                </div>
                <input
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  placeholder={t("montage.poolSearchPlaceholder")}
                  className="w-full rounded-lg border border-cs2-border bg-cs2-bg-input px-3.5 py-2 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted outline-none focus:border-cs2-accent"
                />
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={selectAllFilteredLibrary}
                    disabled={filteredLibrary.length === 0}
                    className="w-full rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 py-2 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-border-focus hover:bg-cs2-surface-2 transition-all disabled:opacity-35"
                  >
                    {t("montage.poolSelectAllBtn", { n: filteredLibrary.length })}
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={addFilteredToSequence}
                      disabled={filteredLibrary.length === 0}
                      className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 py-2 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-accent/40 hover:bg-cs2-surface-2 transition-all disabled:opacity-35"
                    >
                      {t("montage.poolAddAllFilteredBtn")}
                    </button>
                    <button
                      type="button"
                      onClick={addSelectionToTimeline}
                      disabled={librarySelectedIds.size === 0}
                      className="rounded-lg border border-cs2-accent/40 bg-cs2-accent-soft py-2 text-xs font-semibold text-cs2-accent hover:bg-cs2-accent/20 transition-all disabled:opacity-35"
                    >
                      {t("montage.poolAddSelectionBtn", { n: librarySelectedIds.size })}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={openBatchDeleteLibraryPrompt}
                    disabled={librarySelectedIds.size === 0}
                    className="rounded-lg border border-rose-500/20 bg-rose-500/10 py-2 text-xs font-semibold text-rose-400 hover:bg-rose-500/20 transition-all disabled:opacity-35"
                  >
                    {t("montage.poolBatchDeleteBtn", { n: librarySelectedIds.size })}
                  </button>
                </div>
                  </div>
                ) : null}
              </div>
              <div data-testid="montage-pool-list-card" className="min-h-0 flex-1 overflow-y-auto rounded-[10px] border border-cs2-border bg-cs2-bg-card px-2 pb-3 pt-2">
                {loading ? (
                  <div className="flex items-center gap-2 py-10 text-xs text-cs2-text-secondary">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("montage.poolLoading")}
                  </div>
                ) : items.length === 0 ? (
                  <p className="rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-6 text-xs leading-relaxed text-cs2-text-muted text-center">
                    {t("montage.poolEmpty")}
                  </p>
                ) : filteredLibrary.length === 0 ? (
                  <p className="text-xs text-cs2-text-muted p-4 text-center">{t("montage.poolNoMatch")}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {filteredLibrary.map((clip, idx) => (
                      <MontageMaterialPoolCard
                        key={clip.id}
                        index={idx + 1}
                        clip={clip}
                        added={orderedIdSet.has(clip.id)}
                        selected={librarySelectedIds.has(clip.id)}
                        onAdd={addToSequence}
                        onDelete={(c) => {
                          setBatchDeleteLibraryPrompt(null);
                          setDeleteClipPrompt(c);
                        }}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onClickMulti={onLibraryCardMultiClick}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </aside>

            {/* 中间：合集结构（编排主线） */}
            <section data-testid="montage-orchestration-card" className="montage-workbench-panel montage-workbench-orchestration flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-cs2-border bg-cs2-bg-card">
              {unknownDurationHint ? (
                <p className="mx-3 mt-3 shrink-0 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-cs2-amber-on-surface">{unknownDurationHint}</p>
              ) : null}
              <MontageOrchestrationTimeline
                clips={orderedClips}
                primarySelectedId={selectedTimelineClipId}
                multiSelectedIds={timelineMultiSelectedIds}
                onRowPointerDown={onOrchestrationRowClick}
                dragId={dragId}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOver={onDragOverItem}
                onDropOnRow={onTimelineCanvasDrop}
                onRemoveOne={removeFromSequence}
                transitionByClipId={transitionByClipId}
                formatTransitionLine={(map, id) => formatTransitionNodeLine(map, id, t)}
                transitionEdgeSourceId={transitionEdgeSourceId}
                onTransitionEdgeFocusChange={setTransitionEdgeSourceId}
                getEffectiveTransition={getEffectiveTransition}
                patchTransition={patchTransition}
                transitionTypeOptions={transitionTypeOptions}
                onApplyGlobalTransitionType={applyGlobalTransitionType}
                onApplyGlobalDurationToAll={applyGlobalDurationToAll}
                onApplyRandomTransitions={applyRandomTransitions}
                onApplyKillTypeTransitions={applyKillTypeTransitions}
                globalTransitionTemplates={globalTransitionTemplates}
                onApplyGlobalTemplate={applyGlobalTransitionTemplate}
                onBulkRemove={removeTimelineMulti}
                multiCount={timelineMultiSelectedIds.size}
                onBulkMoveUp={() => shiftTimelineSelection(-1)}
                onBulkMoveDown={() => shiftTimelineSelection(1)}
                onClearTimeline={clearTimeline}
                timelineClipCount={orderedIds.length}
              />
            </section>

            {/* 右侧：合辑成片控制台 */}
            <div data-testid="montage-console-card" className="montage-workbench-panel montage-workbench-console flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-cs2-border bg-cs2-bg-card">
              <MontageStyleConsole
                bgmPath={bgmPath}
                onBgmPathChange={setBgmPath}
                onBgmClear={() => setBgmPath("")}
                bgmVolume={bgmVolume}
                onBgmVolumeChange={setBgmVolume}
                bgmStartSec={bgmStartSec}
                onBgmStartSecChange={setBgmStartSec}
                introPath={introPath}
                onIntroPathChange={setIntroPath}
                onIntroClear={() => setIntroPath("")}
                introDuration={introDuration}
                onIntroDurationChange={setIntroDuration}
                outroPath={outroPath}
                onOutroPathChange={setOutroPath}
                onOutroClear={() => setOutroPath("")}
                outroDuration={outroDuration}
                onOutroDurationChange={setOutroDuration}
                onMediaDropHint={showToast}
                onFilePick={pickFile}
                clipCount={orderedIds.length}
                durationText={durationText}
                resolutionLabel={t("montage.resolutionLabel")}
                exporting={exporting}
                onExport={() => void runExport()}
                exportReady={exportReady}
                fullOutputPathPreview={fullOutputPathPreview}
                outputFilename={outputFilename}
                onOutputFilenameChange={setOutputFilename}
                defaultFilenamePlaceholder={buildTimestampMontageFilename()}
                outputDir={outputDir}
                onOutputDirChange={handleOutputDirChange}
                onOutputDirCommit={handleOutputDirCommit}
                onOutputDirBrowse={handleOutputDirBrowse}
                onOutputDirClear={handleOutputDirClear}
                effectiveOutputDirHint={!outputDir.trim() && effectiveOutputDir ? effectiveOutputDir : ""}
                exportOk={exportOk}
                lastExport={lastExport}
                exportDirForButton={exportDirForButton}
                onCopyText={copyText}
                onDismissExportSuccess={() => setLastExport(null)}
                clips={orderedClips}
                playerAvatars={playerAvatars}
                nameCardsEnabled={nameCardsEnabled}
                onPlayerAvatarChange={handlePlayerAvatarChange}
                onNameCardsEnabledChange={setNameCardsEnabled}
                framemeldEnabled={effectiveFrameMeldEnabled}
                framemeldRuntimeAvailable={ffmpegGate.framemeldAvailable}
                framemeldSourceSummary={framemeldSourceSummary}
                onFrameMeldEnabledChange={handleFrameMeldEnabledChange}
              />
            </div>

          </div>
        </div>
      </div>
      {deleteClipPrompt ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="montage-delete-clip-title"
          onClick={() => setDeleteClipPrompt(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="montage-delete-clip-title" className="mb-3 text-sm font-bold text-cs2-text-primary">
              {t("montage.deleteClipTitle")}
            </h4>
            <p className="mb-1.5 font-mono text-xs font-semibold text-cs2-text-secondary bg-cs2-surface-1 p-2 rounded-md truncate">
              {clipBasename(deleteClipPrompt) || getClipTitle(deleteClipPrompt, t)}
            </p>
            <p className="mb-3 text-xs leading-relaxed text-cs2-text-muted">
              {t("montage.deleteClipDesc")}
            </p>
            {deleteClipPrompt.output_path ? (
              <p className="mb-4 break-all font-mono text-xs text-cs2-text-muted bg-cs2-bg-input p-2 rounded max-h-20 overflow-y-auto" title={String(deleteClipPrompt.output_path)}>
                {String(deleteClipPrompt.output_path)}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap justify-end gap-2.5">
              <button
                type="button"
                className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-4 py-2 text-xs font-medium text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all"
                onClick={() => setDeleteClipPrompt(null)}
              >
                {t("montage.deleteClipCancel")}
              </button>
              <button
                type="button"
                className="rounded-lg border border-rose-500/30 bg-rose-500 px-4 py-2 text-xs font-bold text-dynamic-white hover:bg-rose-600 shadow-sm transition-all"
                onClick={() => void confirmDeleteLibraryClip()}
              >
                {t("montage.deleteClipConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {batchDeleteLibraryPrompt?.length ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="montage-batch-delete-title"
          onClick={() => setBatchDeleteLibraryPrompt(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="montage-batch-delete-title" className="mb-3 text-sm font-bold text-cs2-text-primary">
              {t("montage.batchDeleteTitle")}
            </h4>
            <p className="mb-3 text-xs leading-relaxed text-cs2-text-secondary">
              {t("montage.batchDeleteDesc", { n: batchDeleteLibraryPrompt.length })}
            </p>
            <ul className="mb-4 max-h-40 overflow-y-auto rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 p-2 font-mono text-xs text-cs2-text-secondary space-y-1">
              {batchDeleteLibraryPrompt.map((c) => (
                <li key={c.id} className="truncate py-0.5 hover:text-cs2-text-primary transition-colors" title={clipBasename(c) || getClipTitle(c, t)}>
                  {clipBasename(c) || getClipTitle(c, t)}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap justify-end gap-2.5">
              <button
                type="button"
                className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 px-4 py-2 text-xs font-medium text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary transition-all"
                onClick={() => setBatchDeleteLibraryPrompt(null)}
              >
                {t("montage.batchDeleteCancel")}
              </button>
              <button
                type="button"
                className="rounded-lg border border-rose-500/30 bg-rose-500 px-4 py-2 text-xs font-bold text-dynamic-white hover:bg-rose-600 shadow-sm transition-all"
                onClick={() => void confirmBatchDeleteLibraryClips()}
              >
                {t("montage.batchDeleteConfirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <LiteCutExportProgressDialog
        variant="montage"
        phase={exportDialog.phase}
        result={exportDialog.result}
        error={exportDialog.error}
        onClose={() => setExportDialog({ phase: "idle", result: null, error: "" })}
        onCancel={() => void handleCancelExport()}
      />
    </>
  );

  if (isPage) {
    return (
      <div className="montage-workbench-page flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden px-3 pb-3 pt-2 sm:px-4 sm:pb-4 sm:pt-3">
        {inner}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex justify-end bg-black/60 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="montage-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {inner}
    </div>
  );
}
