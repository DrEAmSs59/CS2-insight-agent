import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import API from "../api/api";
import { calibrateObs, getObsConfigStatus } from "../api/obsConfigCenter";
import { useT } from "../i18n/useT.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import { useAppShell } from "../context/AppShellContext";
import { desktopBridge } from "../desktop/desktopBridge.js";
import RecordingParamsPage from "./RecordingParamsPage";
import SponsorModal from "../components/SponsorModal";
import ObsAiSettingsPanel from "../components/ObsAiSettingsPanel";
import ObsHostField from "../components/settings/ObsHostField.jsx";
import { formatFileSize } from "../utils/demoLibraryDisplay.js";
import {
  Settings as SettingsIcon,
  Search,
  Loader2,
  Save,
  CheckCircle2,
  XCircle,
  SlidersHorizontal,
  Brain,
  FolderOpen,
  Monitor,
  AlertTriangle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Gamepad2,
  Download,
  // 新增图标
  Github,
  Bug,
  Lightbulb,
  Mail,
  Heart,
  X,
} from "lucide-react";

// The AI insight mode remains available for demo review, but OBS recommendation
// is intentionally kept behind a local release gate until the workflow is ready.
const AI_OBS_RECOMMENDATION_ENABLED = false;

/* ---------------------------------------------------------------------------
 * Helper function to open external links in system default browser
 * ------------------------------------------------------------------------ */

function openExternalLink(url) {
  if (desktopBridge) {
    void desktopBridge.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

const ISSUE_TEMPLATE_URLS = {
  zh: {
    bug: "https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=bug_report.yml",
    feature: "https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=feature_request.yml",
  },
  en: {
    bug: "https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=bug_report_en.yml",
    feature: "https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=feature_request_en.yml",
  },
};

function openIssueTemplate(type) {
  const { effectiveLocale } = useLocaleStore.getState();
  openExternalLink(ISSUE_TEMPLATE_URLS[effectiveLocale]?.[type] ?? ISSUE_TEMPLATE_URLS.zh[type]);
}

/* ---------------------------------------------------------------------------
 * Reusable field-row primitives
 * ------------------------------------------------------------------------ */

function SectionCard({ title, hint, children, search, className, contentClassName }) {
  if (search) return null;
  return (
    <div className={`rounded-xl border border-cs2-border/70 bg-cs2-bg-card px-4 py-3.5 ${className ?? ""}`}>
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-cs2-text-secondary">{title}</h2>
        {hint && <span className="text-xs text-cs2-text-muted">{hint}</span>}
      </div>
      <div className={contentClassName ?? "divide-y divide-cs2-border/40"}>
        {children}
      </div>
    </div>
  );
}

function SectionHeader({ title, hint, search, sectionId }) {
  if (search) return null;
  return (
    <div id={sectionId} className="mt-5 first:mt-1">
      <h2 className="text-sm font-bold uppercase tracking-wide text-cs2-text-secondary">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-cs2-text-muted">{hint}</p>}
      <div className="mt-1.5 border-b border-cs2-border/50" />
    </div>
  );
}

function FieldRow({ label, hint, children, search }) {
  if (search) return null;
  return (
    <div className="py-2.5">
      <label className="block text-xs font-semibold text-cs2-text-secondary">{label}</label>
      {hint && <p className="mb-1 text-xs text-cs2-text-muted">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange, placeholder, type, className }) {
  return (
    <input
      type={type ?? "text"}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none ${className ?? ""}`}
    />
  );
}

function TextArea({ value, onChange, placeholder, rows, className }) {
  return (
    <textarea
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows ?? 3}
      className={`w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-mono text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none resize-y ${className ?? ""}`}
    />
  );
}

function NumberInput({ value, onChange, min, max, step, className }) {
  return (
    <input
      type="number"
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? "" : Number(v));
      }}
      min={min}
      max={max}
      step={step ?? 1}
      className={`w-32 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary focus-visible:border-cs2-accent focus-visible:outline-none ${className ?? ""}`}
    />
  );
}

function SelectInput({ value, onChange, options, className }) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary focus-visible:border-cs2-accent focus-visible:outline-none ${className ?? ""}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({ value, onChange, onLabel, offLabel, ariaLabel }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-label={ariaLabel ?? (value ? (onLabel ?? "On") : (offLabel ?? "Off"))}
        aria-pressed={value}
        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
          value ? "bg-cs2-accent" : "bg-cs2-bg-input"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-cs2-text-on-accent shadow transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      <span className="text-[11px] text-cs2-text-muted">{value ? (onLabel ?? "On") : (offLabel ?? "Off")}</span>
    </div>
  );
}

function PathPicker({ value, onChange, placeholder, exeName, detectApi, detectField, t }) {
  const fileRef = useRef();
  const [detecting, setDetecting] = useState(false);

  const handleBrowse = async () => {
    // 如果没有值，先尝试自动检测
    if (!value || !value.trim()) {
      if (detectApi) {
        setDetecting(true);
        try {
          const { data } = await API.post(detectApi);
          const detectedPath = data[detectField];
          if (detectedPath) {
            onChange(detectedPath);
            return;
          }
        } catch {
          // 检测失败，继续打开文件选择对话框
        } finally {
          setDetecting(false);
        }
      }
    }

    // 后端原生文件选择（Windows；浏览器开发模式也可返回完整路径）
    try {
      const { data } = await API.post("file-picker", { file_type: "exe" });
      if (data?.path) {
        onChange(data.path);
        return;
      }
    } catch {
      // 非 Windows 或选择器不可用，继续 fallback
    }

    // 桌面壳文件选择对话框
    if (desktopBridge) {
      try {
        const defaultPath = value && value.trim() ? value : undefined;
        const result = await desktopBridge.showOpenDialog({
          title: t("settings.browseFileTitle"),
          defaultPath,
          filters: [{ name: exeName, extensions: ["exe"] }],
          properties: ["openFile"],
        });
        if (!result.canceled && result.filePaths?.[0]) {
          onChange(result.filePaths[0]);
        }
        return;
      } catch (e) {
        console.error("Desktop dialog error:", e);
      }
    }

    // 最后兜底：HTML file input（浏览器中通常只能拿到文件名）
    fileRef.current?.click();
  };

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none"
      />
      <button
        type="button"
        onClick={handleBrowse}
        disabled={detecting}
        className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent disabled:opacity-50"
      >
        {detecting ? <Loader2 className="h-3 w-3 animate-spin" /> : t("settings.browseBtn")}
      </button>
      {/* 浏览器环境的最后兜底 */}
      <input
        ref={fileRef}
        type="file"
        accept=".exe"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onChange(file.path ?? file.webkitRelativePath ?? file.name);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function TagList({ items, onChange, placeholder, addLabel, emptyLabel }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) { setDraft(""); return; }
    onChange([...items, v]);
    setDraft("");
  };
  const remove = (idx) => onChange(items.filter((_, i) => i !== idx));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 && <span className="text-[11px] text-cs2-text-muted">{emptyLabel}</span>}
        {items.map((name, idx) => (
          <span key={`${name}-${idx}`} className="inline-flex items-center gap-1 rounded-md bg-cs2-bg-input px-2 py-1 text-[11px] text-cs2-text-primary">
            {name}
            <button type="button" onClick={() => remove(idx)} className="ml-0.5 text-cs2-text-muted hover:text-red-400">×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none"
        />
        <button type="button" onClick={add} className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent">
          {addLabel}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Static dropdown options
 * ------------------------------------------------------------------------ */

// 格式化上次检查时间（ISO 8601 UTC -> 本地友好显示）
function formatLastCheckTime(isoUtc, t, locale) {
  if (!isoUtc) return "";
  try {
    const d = new Date(isoUtc);
    if (isNaN(d.getTime())) return isoUtc;
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);
    if (diffMin < 1) return t("settings.timeJustNow");
    if (diffMin < 60) return t("settings.timeMinutesAgo", { n: diffMin });
    if (diffHour < 24) return t("settings.timeHoursAgo", { n: diffHour });
    if (diffDay < 7) return t("settings.timeDaysAgo", { n: diffDay });
    // 超过一周显示具体日期
    const dateLocale = locale === "zh" ? "zh-CN" : "en";
    return d.toLocaleDateString(dateLocale) + " " + d.toLocaleTimeString(dateLocale, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return isoUtc;
  }
}
const ENCODER_OPTIONS = [
  { value: "auto", key: "settings.encoderAuto" },
  { value: "h264_nvenc", key: "settings.encoderNvenc" },
  { value: "h264_qsv", key: "settings.encoderQsv" },
  { value: "h264_amf", key: "settings.encoderAmf" },
  { value: "libx264", key: "settings.encoderX264" },
];

/* ---------------------------------------------------------------------------
 * Tab definitions
 * ------------------------------------------------------------------------ */
const TABS = [
  { key: "general", icon: SettingsIcon, labelKey: "settings.tabGeneral" },
  { key: "paths", icon: FolderOpen, labelKey: "settings.tabPaths" },
  { key: "video", icon: Monitor, labelKey: "settings.tabVideo" },
  { key: "parse", icon: Brain, labelKey: "settings.tabParse" },
  { key: "recording", icon: SlidersHorizontal, labelKey: "settings.tabRecording" },
];

const VALID_TAB_KEYS = new Set(TABS.map((tab) => tab.key));

function resolveTabFromSearch(searchParams) {
  const tab = searchParams.get("tab");
  return tab && VALID_TAB_KEYS.has(tab) ? tab : "general";
}

/* ---------------------------------------------------------------------------
 * Main page
 * ------------------------------------------------------------------------ */

export default function SettingsPage() {
  const t = useT();
  const effectiveLocale = useLocaleStore((state) => state.effectiveLocale);
  const [searchParams] = useSearchParams();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState(() => resolveTabFromSearch(searchParams));
  const [dataDirInfo, setDataDirInfo] = useState(null);
  const [replayCacheInfo, setReplayCacheInfo] = useState(null);
  const [replayCacheBusy, setReplayCacheBusy] = useState(false);
  const [replayCacheMsg, setReplayCacheMsg] = useState(null);
  const [liteCutStorage, setLiteCutStorage] = useState(null);
  const [liteCutStorageDraft, setLiteCutStorageDraft] = useState("");
  const [liteCutStorageBusy, setLiteCutStorageBusy] = useState(false);
  const [liteCutStorageMsg, setLiteCutStorageMsg] = useState(null);
  const [liteCutStorageJob, setLiteCutStorageJob] = useState(null);
  const [demoCacheInfo, setDemoCacheInfo] = useState(null);
  const [demoCacheDraft, setDemoCacheDraft] = useState("");
  const [demoCacheBusy, setDemoCacheBusy] = useState(false);
  const [demoCacheMsg, setDemoCacheMsg] = useState(null);
  const recordingSaveRef = useRef(null);
  const [recordingSaveUi, setRecordingSaveUi] = useState({ disabled: true, state: "idle" });

  const registerRecordingSave = useCallback((save) => {
    recordingSaveRef.current = save;
  }, []);

  const updateRecordingSaveUi = useCallback((next) => {
    setRecordingSaveUi((prev) => (
      prev.disabled === next.disabled && prev.state === next.state ? prev : next
    ));
  }, []);

  const handleRecordingSave = useCallback(() => {
    recordingSaveRef.current?.();
  }, []);

  // OBS Config Check / Calibrate
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrateResult, setCalibrateResult] = useState(null);

  // Sponsor Modal
  const [showSponsorModal, setShowSponsorModal] = useState(false);

  // Player Game Config
  const shell = useAppShell();
  const playerConfigLoading = shell.configBackupLoading;
  const playerConfigStatus = shell.configBackupStatus;

  useEffect(() => {
    setActiveTab(resolveTabFromSearch(searchParams));
  }, [searchParams]);

  // Load config on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await API.get("config");
        if (!cancelled) setConfig(data);
      } catch (e) {
        if (!cancelled) console.error("Failed to load config:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    API.get("demo/replay/cache")
      .then(({ data }) => {
        if (!cancelled) setReplayCacheInfo(data);
      })
      .catch((error) => {
        if (!cancelled) console.error("Failed to load replay cache info:", error);
      });
    return () => { cancelled = true; };
  }, []);

  const clearReplayCache = useCallback(async () => {
    if (replayCacheBusy || !window.confirm(t("settings.replayCacheConfirm"))) return;
    setReplayCacheBusy(true);
    setReplayCacheMsg(null);
    try {
      const { data } = await API.delete("demo/replay/cache");
      setReplayCacheInfo(data?.cache ?? null);
      setReplayCacheMsg({ tone: "ok", text: t("settings.replayCacheCleared", {
        size: formatFileSize(Number(data?.removed_bytes) || 0),
      }) });
      const { data: nextDataDirInfo } = await API.get("config/data-dir-info");
      setDataDirInfo(nextDataDirInfo);
    } catch (error) {
      setReplayCacheMsg({
        tone: "error",
        text: error.response?.data?.detail || error.message || t("settings.replayCacheFailed"),
      });
    } finally {
      setReplayCacheBusy(false);
    }
  }, [replayCacheBusy, t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await API.get("demo-cache");
        if (!cancelled) {
          setDemoCacheInfo(data);
          setDemoCacheDraft(data?.path ?? "");
        }
      } catch (e) {
        if (!cancelled) console.error("Failed to load demo cache info:", e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const browseDemoCache = useCallback(async () => {
    try {
      let selected = "";
      if (desktopBridge) {
        selected = await desktopBridge.chooseDirectory(demoCacheDraft);
      } else {
        const { data } = await API.post("directory-picker");
        selected = data?.path ?? "";
      }
      if (selected) {
        setDemoCacheDraft(selected);
        setDemoCacheMsg(null);
      }
    } catch (e) {
      setDemoCacheMsg({ tone: "error", text: e.response?.data?.detail || e.message });
    }
  }, [demoCacheDraft]);

  const migrateDemoCache = useCallback(async () => {
    const destination = demoCacheDraft.trim();
    if (!destination || demoCacheBusy) return;
    if (!window.confirm(t("settings.demoCacheMigrateConfirm"))) return;
    setDemoCacheBusy(true);
    setDemoCacheMsg(null);
    try {
      const { data } = await API.post("demo-cache/migrate", { destination });
      setDemoCacheInfo((prev) => ({ ...(prev || {}), ...data, custom: true }));
      setDemoCacheDraft(data.path || destination);
      setConfig((prev) => (prev ? { ...prev, demo_cache_directory: data.path || destination } : prev));
      setDemoCacheMsg({
        tone: "ok",
        text: data.unchanged
          ? t("settings.demoCacheUnchanged")
          : t("settings.demoCacheMigrateSuccess", {
              moved: data.moved ?? 0,
              updated: data.db_updated ?? 0,
            }),
      });
    } catch (e) {
      setDemoCacheMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message || t("settings.demoCacheMigrateFailed"),
      });
    } finally {
      setDemoCacheBusy(false);
    }
  }, [demoCacheBusy, demoCacheDraft, t]);

  const clearDemoCache = useCallback(async () => {
    if (demoCacheBusy || !window.confirm(t("settings.demoCacheClearConfirm"))) return;
    setDemoCacheBusy(true);
    setDemoCacheMsg(null);
    try {
      const { data } = await API.post("demo-cache/clear");
      const { data: next } = await API.get("demo-cache");
      setDemoCacheInfo(next);
      setDemoCacheDraft(next?.path ?? demoCacheDraft);
      setDemoCacheMsg({
        tone: "ok",
        text: t("settings.demoCacheClearSuccess", {
          files: data.removed_files ?? 0,
          demos: data.demos_invalidated ?? 0,
        }),
      });
    } catch (e) {
      setDemoCacheMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message || t("settings.demoCacheClearFailed"),
      });
    } finally {
      setDemoCacheBusy(false);
    }
  }, [demoCacheBusy, demoCacheDraft, t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await API.get("lite-cut/storage");
        if (!cancelled) {
          setLiteCutStorage(data);
          setLiteCutStorageDraft(data?.path ?? "");
        }
      } catch (e) {
        if (!cancelled) console.error("Failed to load LiteCut storage info:", e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const browseLiteCutStorage = useCallback(async () => {
    try {
      let selected = "";
      if (desktopBridge) {
        selected = await desktopBridge.chooseDirectory(liteCutStorageDraft);
      } else {
        const { data } = await API.post("directory-picker");
        selected = data?.path ?? "";
      }
      if (selected) {
        setLiteCutStorageDraft(selected);
        setLiteCutStorageMsg(null);
      }
    } catch (e) {
      setLiteCutStorageMsg({ tone: "error", text: e.response?.data?.detail || e.message });
    }
  }, [liteCutStorageDraft]);

  const migrateLiteCutStorage = useCallback(async () => {
    const destination = liteCutStorageDraft.trim();
    if (!destination || liteCutStorageBusy) return;
    if (!window.confirm(t("settings.liteCutStorageConfirm"))) return;
    setLiteCutStorageBusy(true);
    setLiteCutStorageMsg(null);
    try {
      let { data } = await API.post("lite-cut/storage/migrate", { destination });
      setLiteCutStorageJob(data);
      while (data?.job_id && ["queued", "running", "cancelling"].includes(data?.status)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        ({ data } = await API.get(`lite-cut/storage/migrate/${data.job_id}`));
        setLiteCutStorageJob(data);
      }
      if (data?.status === "cancelled") {
        setLiteCutStorageDraft(data.path || liteCutStorage?.path || destination);
        setLiteCutStorageMsg({ tone: "warn", text: data.error || t("settings.liteCutStorageCancelled") });
        return;
      }
      if (data?.status !== "done") throw new Error(data?.error || t("settings.liteCutStorageFailed"));
      setLiteCutStorage((prev) => ({
        ...(prev || {}),
        ...data,
        custom: data.path !== prev?.default_path,
      }));
      setLiteCutStorageDraft(data.path);
      setConfig((prev) => prev ? { ...prev, lite_cut_assets_dir: data.path } : prev);
      setLiteCutStorageMsg({
        tone: data.warning ? "warn" : "ok",
        text: data.warning || t("settings.liteCutStorageSuccess"),
      });
    } catch (e) {
      setLiteCutStorageMsg({ tone: "error", text: e.response?.data?.detail || e.message || t("settings.liteCutStorageFailed") });
    } finally {
      setLiteCutStorageBusy(false);
    }
  }, [liteCutStorage?.path, liteCutStorageBusy, liteCutStorageDraft, t]);

  const cancelLiteCutStorageMigration = useCallback(async () => {
    if (!liteCutStorageJob?.job_id || !liteCutStorageBusy) return;
    try {
      const { data } = await API.delete(`lite-cut/storage/migrate/${liteCutStorageJob.job_id}`);
      setLiteCutStorageJob(data);
    } catch (e) {
      setLiteCutStorageMsg({ tone: "error", text: e.response?.data?.detail || e.message });
    }
  }, [liteCutStorageBusy, liteCutStorageJob?.job_id]);

  // 桌面包读取 Tauri 版本；浏览器预览使用 Vite 构建版本。
  const [appVersion, setAppVersion] = useState(__APP_VERSION__);
  useEffect(() => {
    if (desktopBridge) {
      desktopBridge.getVersion().then((v) => {
        if (v) setAppVersion(v);
      }).catch(() => {});
    }
  }, []);

  // Load data directory info
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await API.get("config/data-dir-info");
        if (!cancelled) setDataDirInfo(data);
      } catch (e) {
        if (!cancelled) console.error("Failed to load data dir info:", e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Refresh player config status on mount
  useEffect(() => {
    void shell.refreshConfigBackupStatus();
  }, [shell.refreshConfigBackupStatus]);

  // Deep-set helper
  const set = useCallback((path, value) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      const parts = path.split(".");
      let cur = next;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = { ...(cur[parts[i]] ?? {}) };
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  }, []);

  // ─── Save handler (defined early because handleCalibrate depends on it) ───

  const handleSave = useCallback(async () => {
    if (!config || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const payload = {};
      const obs = config.obs ?? {};
      const llm = config.llm ?? {};

      payload.cs2_path = config.cs2_path ?? "";
      payload.ffmpeg_path = config.ffmpeg_path ?? "";
      payload.montage_encoder = config.montage_encoder ?? "auto";
      payload.ai_mode = !!config.ai_mode;
      payload.obs_agent_auto_prepare = !!config.obs_agent_auto_prepare;
      payload.locale = config.locale ?? "auto";
      payload.demo_directory = config.demo_directory ?? "";
      payload.demo_cache_directory = config.demo_cache_directory ?? "";
      payload.demo_watch_paths = config.demo_watch_paths ?? [];
      payload.expected_parse_players = config.expected_parse_players ?? [];
      payload.steam_api_key = config.steam_api_key ?? "";
      payload.steam_id64 = config.steam_id64 ?? "";
      payload.steam_cdn_assets_enabled = config.steam_cdn_assets_enabled !== false;
      payload.match_mode = config.match_mode ?? "premier";
      payload.match_count = config.match_count ?? 20;

      payload.obs = {
        host: obs.host ?? "localhost",
        port: obs.port ?? 4455,
        password: obs.password ?? "",
        obs_path: obs.obs_path ?? "",
      };

      payload.llm = {
        base_url: llm.base_url ?? null,
        model: llm.model ?? "",
        api_key: llm.api_key ?? "",
        provider: llm.provider ?? "",
      };

      await API.put("config", payload);
      useLocaleStore.getState().hydrate(payload.locale);
      setSaveMsg({ text: t("app.settingsSaved") ?? "Saved", tone: "ok" });
    } catch (e) {
      setSaveMsg({ text: e.response?.data?.detail || e.message || "Save failed", tone: "error" });
    } finally {
      setSaving(false);
    }
  }, [config, saving, t]);

  // ─── OBS Config Check / Calibrate ──────────────────────────────

  const fetchObsStatus = useCallback(async () => {
    const st = await getObsConfigStatus();
    setStatus(st);
  }, []);

  const refreshStatusSilent = useCallback(async () => {
    try { await fetchObsStatus(); } catch { /* silent */ }
  }, [fetchObsStatus]);

  const handleConfigCheck = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      const obs = config.obs ?? {};
      const { data } = await API.post("/obs/config-check", {
        host: obs.host ?? "localhost",
        port: obs.port ?? 4455,
        password: obs.password ?? "",
        obs_path: obs.obs_path ?? "",
      });
      setCheckResult(data);
      if (data.connected) {
        await fetchObsStatus();
      }
    } catch (e) {
      setCheckResult({ error: e.response?.data?.detail || e.message || t("obscfg.errorCheckFail") });
    } finally {
      setChecking(false);
    }
  }, [config, fetchObsStatus, t]);

  const handleCalibrate = useCallback(async () => {
    setCalibrating(true);
    setCalibrateResult(null);
    try {
      // Save first so the backend config has the latest OBS connection params
      await handleSave();
      const data = await calibrateObs();
      setCalibrateResult(data);
      await refreshStatusSilent();
    } catch (e) {
      setCalibrateResult({ error: e.response?.data?.detail || e.message || t("obscfg.errorCalibrateFail") });
    } finally {
      setCalibrating(false);
    }
  }, [handleSave, refreshStatusSilent, t]);

  const handleRefreshStatus = useCallback(async () => {
    setStatusRefreshing(true);
    try { await refreshStatusSilent(); } finally { setStatusRefreshing(false); }
  }, [refreshStatusSilent]);

  const obsStatusRows = useCallback((s) => {
    if (!s?.obs_connected) return [];
    return [
      {
        label: t("obscfg.rowCanvas"),
        value: `${s.video?.base_width ?? 0}×${s.video?.base_height ?? 0}`,
        ok: s.video?.base_width === s.monitor?.width && s.video?.base_height === s.monitor?.height,
        issue: t("obscfg.resShouldBe", { w: s.monitor?.width ?? "?", h: s.monitor?.height ?? "?" }),
      },
      {
        label: t("obscfg.rowOutput"),
        value: `${s.video?.output_width ?? 0}×${s.video?.output_height ?? 0}`,
        ok: s.video?.output_width === s.monitor?.width && s.video?.output_height === s.monitor?.height,
        issue: t("obscfg.resShouldBe", { w: s.monitor?.width ?? "?", h: s.monitor?.height ?? "?" }),
      },
      {
        label: t("obscfg.rowScene"),
        value: s.scene?.dedicated_scene_exists ? t("obscfg.sceneExists") : t("obscfg.sceneNotExists"),
        ok: s.scene?.dedicated_scene_exists ?? false,
        issue: t("obscfg.sceneIssue"),
      },
      {
        label: t("obscfg.rowCapture"),
        value: !s.scene?.dedicated_scene_exists ? "—" : s.scene?.capture_source_exists ? t("obscfg.captureExists") : t("obscfg.captureNotExists"),
        ok: s.scene?.dedicated_scene_exists ? (s.scene?.capture_source_exists ?? false) : true,
        issue: t("obscfg.captureIssue"),
        skip: !s.scene?.dedicated_scene_exists,
      },
      {
        label: t("obscfg.rowStretch"),
        value: !s.scene?.capture_source_exists ? "—" : s.scene?.source_fit_to_canvas ? t("obscfg.stretchFit") : t("obscfg.stretchNotFit"),
        ok: s.scene?.capture_source_exists ? (s.scene?.source_fit_to_canvas ?? false) : true,
        issue: t("obscfg.stretchIssue"),
        skip: !s.scene?.capture_source_exists,
      },
      {
        label: t("obscfg.rowFormat"),
        value: (s.recording?.format === "hybrid_mp4" ? t("obscfg.formatHybridMp4") : s.recording?.format === "fragmented_mp4" ? t("obscfg.formatFragMp4") : s.recording?.format ?? t("obscfg.formatUnknown")),
        ok: s.recording?.format === "hybrid_mp4",
        issue: t("obscfg.formatIssue", { val: s.recording?.format === "hybrid_mp4" ? t("obscfg.formatHybridMp4") : s.recording?.format ?? t("obscfg.formatUnknown") }),
      },
      {
        label: t("obscfg.rowQuality"),
        value: s.recording?.rec_quality === "Stream" ? t("obscfg.qualityStream") : s.recording?.rec_quality === "Small" ? t("obscfg.qualitySmall") : s.recording?.rec_quality === "HQ" ? t("obscfg.qualityHq") : s.recording?.rec_quality === "Lossless" ? t("obscfg.qualityLossless") : s.recording?.rec_quality ?? t("obscfg.qualityUnknown"),
        ok: s.recording?.rec_quality !== "Stream" && !!s.recording?.rec_quality,
        issue: t("obscfg.qualityIssue"),
      },
      {
        label: t("obscfg.rowOutputDir"),
        value: s.recording?.output_path || t("obscfg.outputDirNotSet"),
        ok: true,
        infoOnly: true,
        outputPath: s.recording?.output_path || "",
      },
    ];
  }, [t]);

  // Search
  const searchLower = search.trim().toLowerCase();
  const matches = (text) => !searchLower || text.toLowerCase().includes(searchLower);
  const hide = (text) => searchLower && !matches(text) ? { display: "none" } : {};

  if (loading) {
    return (
      <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-cs2-bg-dark">
        <Loader2 className="h-6 w-6 animate-spin text-cs2-accent" />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-cs2-bg-dark">
        <p className="text-sm text-cs2-text-muted">Failed to load config</p>
      </div>
    );
  }

  const obs = config.obs ?? {};
  const llm = config.llm ?? {};
  const aiObsRecommendationEnabled = AI_OBS_RECOMMENDATION_ENABLED && Boolean(config.ai_mode);
  const isLocalEndpoint = llm.base_url && (
    llm.base_url.includes("localhost") || llm.base_url.includes("127.0.0.1")
  );

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-cs2-bg-dark">
      {/* Header */}
      <div className="shrink-0 border-b border-cs2-border/60 px-4 py-3">
        <div className="flex items-center gap-3">
          <SettingsIcon className="h-5 w-5 text-cs2-accent" />
          <div>
            <h1 className="text-lg font-bold tracking-wide text-cs2-text-primary">{t("settings.pageTitle")}</h1>
            <p className="mt-1 text-xs text-cs2-text-muted">{t("settings.pageSubtitle")}</p>
          </div>
        </div>
        {/* Search */}
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("settings.searchPlaceholder")}
            className="w-full rounded-md border border-cs2-border bg-cs2-bg-input py-2 pl-8 pr-3 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none"
          />
        </div>
        {/* Tabs */}
        <div className="mt-3 flex gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  active
                    ? "bg-cs2-accent/15 text-cs2-accent border border-cs2-accent/30"
                    : "text-cs2-text-secondary hover:bg-cs2-bg-input/50 border border-transparent"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className={`min-h-0 flex-1 ${activeTab === "recording" ? "flex flex-col overflow-hidden" : "overflow-y-auto"}`}>
        <div
          className={
            activeTab === "recording"
              ? "flex min-h-0 flex-1 flex-col"
              : activeTab === "video" && aiObsRecommendationEnabled
                ? "w-full px-4 pb-24 pt-2 xl:px-6 2xl:px-8"
                : "mx-auto max-w-4xl px-4 pb-24 pt-2"
          }
        >

          {/* ======================== 通用设置 ======================== */}
          {(activeTab === "general" || activeTab === "paths") && (
            <div className="space-y-4">
              {activeTab === "general" && (
                <>
              {/* System + Language */}
              <SectionCard title={t("settings.sectionSystem")} hint={t("settings.sectionSystemHint")} search={search && !matches(t("settings.sectionSystem") + " " + t("settings.currentVersion") + " " + t("settings.checkUpdateBtn"))}>
                <FieldRow label={t("settings.currentVersion")} hint={t("settings.hintAutoUpdateOnStartup")} search={search && !matches(t("settings.currentVersion") + " version " + t("settings.checkUpdateBtn"))}>
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs text-cs2-text-primary font-mono">{appVersion}</p>
                    {config.last_update_check_at && (
                      <span className="text-xs text-cs2-text-muted">
                        ({t("settings.lastCheckTime")}: {formatLastCheckTime(config.last_update_check_at, t, effectiveLocale)})
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void shell.fetchUpdateInfo({ manual: true })}
                      className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                    >
                      <Download className="h-3.5 w-3.5" />
                      {t("settings.checkUpdateBtn")}
                    </button>
                  </div>
                </FieldRow>

                {/* GitHub 地址 */}
                <div className="py-2.5 flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <label className="block text-xs font-semibold text-cs2-text-secondary">
                      {t("settings.aboutGithub")}
                    </label>
                    <p className="mt-1 text-xs text-cs2-text-muted">
                      {t("settings.aboutGithubDesc")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openExternalLink('https://github.com/DrEAmSs59/CS2-insight-agent')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <Github className="h-3.5 w-3.5" />
                    GitHub
                  </button>
                </div>

                {/* 常用功能 */}
                <div className="mb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-cs2-text-secondary">{t("settings.commonFeatures")}</h3>
                </div>

                {/* 操作按钮 */}
                <div className="py-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => openExternalLink('https://github.com/DrEAmSs59/CS2-insight-agent/issues')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("settings.btnViewIssues")}
                  </button>
                  <button
                    type="button"
                    onClick={() => openIssueTemplate("bug")}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <Bug className="h-3.5 w-3.5" />
                    {t("settings.btnReportBug")}
                  </button>
                  <button
                    type="button"
                    onClick={() => openIssueTemplate("feature")}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <Lightbulb className="h-3.5 w-3.5" />
                    {t("settings.btnRequestFeature")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const subject = t("settings.contactEmailSubject");
                      openExternalLink(`mailto:dreamss29_@outlook.com?subject=${encodeURIComponent(subject)}`);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    {t("settings.btnContact")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSponsorModal(true)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <Heart className="h-3.5 w-3.5" />
                    {t("settings.btnSponsor")}
                  </button>
                </div>
              </SectionCard>

              <SectionCard title={t("settings.sectionLanguage")} search={search && !matches(t("settings.sectionLanguage") + " " + t("settings.labelLocale"))}>
                <FieldRow label={t("settings.labelLocale")} hint={config.locale === "auto" ? t("settings.localeAutoHint", { lang: config.effective_locale === "zh" ? t("settings.localeZh") : t("settings.localeEn") }) : ""} search={search && !matches(t("settings.labelLocale") + " " + t("settings.localeZh"))}>
                  <SelectInput
                    value={config.locale ?? "auto"}
                    onChange={(v) => {
                      const previousLocale = config.locale ?? "auto";
                      set("locale", v);
                      void useLocaleStore.getState().setLocale(v).catch(() => {
                        set("locale", previousLocale);
                        setSaveMsg({ text: t("settings.localePersistFailed"), tone: "error" });
                      });
                    }}
                    options={[
                      { value: "auto", label: t("settings.localeAuto") },
                      { value: "zh", label: t("settings.localeZh") },
                      { value: "en", label: t("settings.localeEn") },
                    ]}
                  />
                </FieldRow>
              </SectionCard>

              <SectionCard title={t("settings.sectionNetworkAssets")} hint={t("settings.sectionNetworkAssetsHint")} search={search && !matches(t("settings.sectionNetworkAssets") + " Steam CDN avatar cs2-lib finish")}>
                <FieldRow label={t("settings.labelSteamCdnAssets")} hint={t("settings.hintSteamCdnAssets")}>
                  <Toggle
                    value={config.steam_cdn_assets_enabled !== false}
                    onChange={(value) => set("steam_cdn_assets_enabled", value)}
                    ariaLabel={t("settings.labelSteamCdnAssets")}
                    onLabel={t("settings.networkAssetsEnabled")}
                    offLabel={t("settings.networkAssetsDisabled")}
                  />
                </FieldRow>
              </SectionCard>
                </>
              )}

              {/* Paths (CS2 + application and LiteCut data directories) */}
              {activeTab === "paths" && (
              <SectionCard title={t("settings.sectionPaths")} hint={t("settings.sectionPathsHint")} search={search && !matches(t("settings.sectionPaths") + " " + t("settings.labelCs2Path") + " " + t("settings.labelLiteCutStorage") + " " + t("settings.labelDemoCachePath") + " " + t("settings.labelDataDirectory") + " " + t("settings.labelLogDirectory"))}>
                <FieldRow label={t("settings.labelCs2Path")} hint={t("settings.hintCs2Path")} search={search && !matches(t("settings.labelCs2Path") + " " + (config.cs2_path ?? ""))}>
                  <PathPicker
                    value={config.cs2_path ?? ""}
                    onChange={(v) => set("cs2_path", v)}
                    placeholder="cs2.exe"
                    exeName="cs2.exe"
                    detectApi="config/detect-cs2"
                    detectField="cs2_path"
                    t={t}
                  />
                </FieldRow>
                <FieldRow label={t("settings.labelLiteCutStorage")} hint={t("settings.hintLiteCutStorage")} search={search && !matches(t("settings.labelLiteCutStorage") + " " + liteCutStorageDraft)}>
                  <div className="space-y-2">
                    <div className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={liteCutStorageDraft}
                        onChange={(event) => {
                          setLiteCutStorageDraft(event.target.value);
                          setLiteCutStorageMsg(null);
                        }}
                        placeholder="D:\\CS2 Insight\\LiteCut"
                        className="min-w-0 flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary focus-visible:border-cs2-accent focus-visible:outline-none"
                      />
                      <span className="shrink-0 text-xs text-cs2-text-muted">
                        {formatFileSize(Number(liteCutStorage?.size_bytes) || 0)}
                      </span>
                      <button
                        type="button"
                        onClick={browseLiteCutStorage}
                        disabled={liteCutStorageBusy}
                        className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary hover:border-cs2-accent/50 hover:text-cs2-accent disabled:opacity-50"
                      >
                        {t("settings.browseBtn")}
                      </button>
                      <button
                        type="button"
                        onClick={migrateLiteCutStorage}
                        disabled={liteCutStorageBusy || !liteCutStorageDraft.trim() || liteCutStorageDraft.trim() === liteCutStorage?.path}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-cs2-accent px-3 py-2 text-xs font-bold text-black hover:bg-cs2-accent-light disabled:opacity-45"
                      >
                        {liteCutStorageBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {liteCutStorageBusy ? t("settings.liteCutStorageMigrating") : t("settings.liteCutStorageMigrate")}
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setLiteCutStorageDraft(liteCutStorage?.default_path ?? "")}
                        disabled={liteCutStorageBusy || !liteCutStorage?.default_path}
                        className="text-[11px] text-cs2-text-muted hover:text-cs2-accent disabled:opacity-50"
                      >
                        {t("settings.liteCutStorageUseDefault")}
                      </button>
                      <button
                        type="button"
                        onClick={() => API.post("open-folder", { path: liteCutStorage?.path }).catch(() => {})}
                        disabled={!liteCutStorage?.path}
                        className="text-[11px] text-cs2-text-muted hover:text-cs2-accent disabled:opacity-50"
                      >
                        {t("settings.liteCutStorageOpenCurrent")}
                      </button>
                      {liteCutStorageBusy && liteCutStorageJob?.job_id && liteCutStorageJob.status !== "cancelling" ? (
                        <button
                          type="button"
                          onClick={cancelLiteCutStorageMigration}
                          className="text-[11px] text-rose-300 hover:text-rose-200"
                        >
                          {t("settings.liteCutStorageCancel")}
                        </button>
                      ) : null}
                    </div>
                    {liteCutStorageBusy && liteCutStorageJob ? (
                      <div className="rounded-md border border-cs2-border bg-cs2-bg-input p-2">
                        <div className="flex items-center justify-between text-[10px] text-cs2-text-muted">
                          <span>{t(`settings.liteCutStorageStage.${liteCutStorageJob.stage || "copying"}`)}</span>
                          <span>{Math.round((Number(liteCutStorageJob.progress) || 0) * 100)}% · {Number(liteCutStorageJob.copied_files) || 0}/{Number(liteCutStorageJob.total_files) || 0}</span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/30">
                          <div className="h-full bg-cs2-accent transition-[width]" style={{ width: `${Math.round((Number(liteCutStorageJob.progress) || 0) * 100)}%` }} />
                        </div>
                      </div>
                    ) : null}
                    {liteCutStorageMsg && (
                      <p className={`text-[11px] ${
                        liteCutStorageMsg.tone === "error" ? "text-red-400" : liteCutStorageMsg.tone === "warn" ? "text-amber-400" : "text-emerald-400"
                      }`}>
                        {liteCutStorageMsg.text}
                      </p>
                    )}
                  </div>
                </FieldRow>
                <FieldRow label={t("settings.labelDemoCachePath")} hint={t("settings.hintDemoCachePath")} search={search && !matches(t("settings.labelDemoCachePath") + " " + (demoCacheDraft || "") + " " + t("settings.sectionDemoCache"))}>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={demoCacheDraft}
                        onChange={(e) => {
                          setDemoCacheDraft(e.target.value);
                          setDemoCacheMsg(null);
                        }}
                        placeholder={demoCacheInfo?.default_path || ""}
                        className="min-w-0 flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary focus-visible:border-cs2-accent focus-visible:outline-none"
                      />
                      <span className="shrink-0 text-xs text-cs2-text-muted">
                        {formatFileSize(Number(demoCacheInfo?.total_bytes) || 0)}
                      </span>
                      <button
                        type="button"
                        onClick={browseDemoCache}
                        disabled={demoCacheBusy}
                        className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary hover:border-cs2-accent/50 hover:text-cs2-accent disabled:opacity-50"
                      >
                        {t("settings.browseBtn")}
                      </button>
                      <button
                        type="button"
                        onClick={migrateDemoCache}
                        disabled={demoCacheBusy || !demoCacheDraft.trim()}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-cs2-accent px-3 py-2 text-xs font-bold text-black hover:bg-cs2-accent-light disabled:opacity-45"
                      >
                        {demoCacheBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {demoCacheBusy ? t("settings.demoCacheMigrating") : t("settings.demoCacheMigrate")}
                      </button>
                      <button
                        type="button"
                        onClick={clearDemoCache}
                        disabled={demoCacheBusy}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-rose-400/50 hover:text-rose-300 disabled:opacity-45"
                      >
                        {t("settings.demoCacheClear")}
                      </button>
                    </div>
                    <p className="text-[10px] text-cs2-text-muted">
                      {t("settings.demoCacheStats", {
                        files: demoCacheInfo?.file_count ?? 0,
                        size: formatFileSize(Number(demoCacheInfo?.total_bytes) || 0),
                        cached: demoCacheInfo?.demo_cached ?? 0,
                        total: demoCacheInfo?.demo_total ?? 0,
                      })}
                    </p>
                    {demoCacheMsg ? (
                      <p className={`text-[11px] ${demoCacheMsg.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>
                        {demoCacheMsg.text}
                      </p>
                    ) : null}
                  </div>
                </FieldRow>
                <FieldRow label={t("settings.labelDataDirectory")} hint={t("settings.hintDataDirectory")} search={search && !matches(t("settings.labelDataDirectory") + " " + (dataDirInfo?.path ?? ""))}>
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={dataDirInfo?.path ?? ""}
                      readOnly
                      className="flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-muted cursor-not-allowed"
                    />
                    <span className="text-xs text-cs2-text-muted min-w-[80px]">
                      {dataDirInfo?.size_str ?? "—"}
                    </span>
                    <button
                      type="button"
                      onClick={() => API.post("config/open-dir").catch(() => {})}
                      className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                    >
                      {t("settings.openDirBtn")}
                    </button>
                  </div>
                </FieldRow>
                <FieldRow label={t("settings.labelReplayCache")} hint={t("settings.hintReplayCache")} search={search && !matches(t("settings.labelReplayCache") + " " + (replayCacheInfo?.path ?? ""))}>
                  <div className="space-y-2">
                    <div className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={replayCacheInfo?.path ?? ""}
                        readOnly
                        className="min-w-0 flex-1 cursor-not-allowed rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-muted"
                      />
                      <span className="min-w-[108px] text-xs text-cs2-text-muted">
                        {formatFileSize(Number(replayCacheInfo?.bytes) || 0)} · {t("settings.replayCacheFiles", { count: Number(replayCacheInfo?.files) || 0 })}
                      </span>
                      <button
                        type="button"
                        onClick={clearReplayCache}
                        disabled={replayCacheBusy || !(Number(replayCacheInfo?.files) > 0)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-rose-400/50 hover:text-rose-300 disabled:opacity-45"
                      >
                        {replayCacheBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {replayCacheBusy ? t("settings.replayCacheClearing") : t("settings.replayCacheClear")}
                      </button>
                    </div>
                    {replayCacheMsg && (
                      <p className={`text-[11px] ${replayCacheMsg.tone === "error" ? "text-red-400" : "text-emerald-400"}`}>
                        {replayCacheMsg.text}
                      </p>
                    )}
                  </div>
                </FieldRow>
                <FieldRow label={t("settings.labelLogDirectory")} hint={t("settings.hintLogDirectory")} search={search && !matches(t("settings.labelLogDirectory") + " " + (dataDirInfo?.logs_path ?? ""))}>
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={dataDirInfo?.logs_path ?? ""}
                      readOnly
                      className="flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-muted cursor-not-allowed"
                    />
                    <button
                      type="button"
                      onClick={() => API.post("config/open-logs").catch(() => {})}
                      className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                    >
                      {t("settings.openLogsBtn")}
                    </button>
                  </div>
                </FieldRow>
              </SectionCard>
              )}

              {/* Player Game Config */}
              {activeTab === "general" && (
              <SectionCard title={t("playercfg.pageTitle")} hint={t("playercfg.pageSubtitle")} search={search && !matches(t("playercfg.pageTitle") + " player config")}>
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => void shell.refreshConfigBackupStatus()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                    {t("playercfg.btnRefresh")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void shell.handleOpenConfigBackupDir()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                    {t("playercfg.btnOpenBackupDir")}
                  </button>
                </div>
                {playerConfigLoading ? (
                  <div className="flex items-center gap-2 text-xs text-cs2-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-cs2-accent" aria-hidden />
                    {t("playercfg.loading")}
                  </div>
                ) : playerConfigStatus?.fetch_failed ? (
                  <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-xs">
                    <p className="font-semibold text-red-200">{t("playercfg.fetchFailTitle")}</p>
                    <p className="mt-1 text-red-100/85">{playerConfigStatus.message}</p>
                    <p className="mt-1 text-cs2-text-muted">
                      {t("playercfg.fetchFailHint", { data: "data", data2: "data", backup: ".cs2_config_backup" })}
                    </p>
                  </div>
                ) : playerConfigStatus?.restore_required ? (
                  <div className="rounded-lg border border-amber-500/45 bg-amber-500/10 px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-amber-200">{t("playercfg.restoreTitle")}</p>
                        <p className="mt-1 text-xs leading-relaxed text-amber-100/85">{t("playercfg.restoreDesc")}</p>
                        {typeof playerConfigStatus.cs2_running === "boolean" && (
                          <p className="mt-1 font-mono text-xs text-amber-200">
                            {playerConfigStatus.cs2_running ? t("playercfg.cs2StatusRunning") : t("playercfg.cs2StatusStopped")}
                          </p>
                        )}
                        {playerConfigStatus.backup_dir && (
                          <p className="mt-1 break-all font-mono text-xs text-cs2-text-muted">
                            {t("playercfg.backupDir")}<span className="text-cs2-text-secondary">{playerConfigStatus.backup_dir}</span>
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2 mt-2">
                          <button
                            type="button"
                            onClick={() => void shell.handleRestorePlayerConfig()}
                            className="rounded-md border border-amber-400/60 bg-amber-500/25 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/35"
                          >
                            {t("playercfg.btnRestore")}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-emerald-500/35 bg-cs2-emerald-surface px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-cs2-emerald-on-surface" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-cs2-emerald-on-surface">{t("playercfg.okTitle")}</p>
                        <p className="mt-1 text-xs leading-relaxed text-cs2-emerald-on-surface">{t("playercfg.okDesc")}</p>
                        {playerConfigStatus?.backup_dir && (
                          <p className="mt-1 break-all font-mono text-xs text-cs2-text-muted">
                            {t("playercfg.backupDir")}<span className="text-cs2-text-secondary">{playerConfigStatus.backup_dir}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </SectionCard>
              )}
            </div>
          )}

          {/* ======================== 视频设置 ======================== */}
          {activeTab === "video" && (
            <div className="space-y-4">
              <div className={aiObsRecommendationEnabled ? "grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]" : "space-y-4"}>
                {/* Paths: OBS + FFmpeg */}
                <SectionCard
                  title={t("settings.sectionPaths")}
                  hint={aiObsRecommendationEnabled ? t("settings.sectionPathsAgentHint") : t("settings.sectionPathsHint")}
                  search={search && !matches(t("settings.sectionPaths") + " " + t("settings.labelObsPath") + " " + t("settings.labelFfmpegPath"))}
                >
                  {!aiObsRecommendationEnabled && (
                    <FieldRow label={t("settings.labelObsPath")} hint={t("settings.hintObsPath")} search={search && !matches(t("settings.labelObsPath") + " " + (obs.obs_path ?? ""))}>
                      <PathPicker
                        value={obs.obs_path ?? ""}
                        onChange={(v) => set("obs.obs_path", v)}
                        placeholder="obs64.exe"
                        exeName="obs64.exe"
                        detectApi="config/detect-obs"
                        detectField="obs_path"
                        t={t}
                      />
                    </FieldRow>
                  )}
                  <FieldRow label={t("settings.labelFfmpegPath")} hint={t("settings.hintFfmpegPath")} search={search && !matches(t("settings.labelFfmpegPath") + " " + (config.ffmpeg_path ?? ""))}>
                    <PathPicker
                      value={config.ffmpeg_path ?? ""}
                      onChange={(v) => set("ffmpeg_path", v)}
                      placeholder="ffmpeg.exe"
                      exeName="ffmpeg.exe"
                      detectApi="config/detect-ffmpeg"
                      detectField="ffmpeg_path"
                      t={t}
                    />
                  </FieldRow>
                </SectionCard>

                {/* Encoder */}
                <SectionCard title={t("settings.sectionEncoder")} hint={t("settings.sectionEncoderHint")} search={search && !matches(t("settings.sectionEncoder") + " " + t("settings.labelMontageEncoder"))}>
                  <FieldRow label={t("settings.labelMontageEncoder")} search={search && !matches(t("settings.labelMontageEncoder"))}>
                    <SelectInput
                      value={config.montage_encoder ?? "auto"}
                      onChange={(v) => set("montage_encoder", v)}
                      options={ENCODER_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
                    />
                  </FieldRow>
                </SectionCard>
              </div>

              {/* OBS: manual controls or AI workspace */}
              {!aiObsRecommendationEnabled ? (
                <>
              <SectionCard
                title={t("settings.sectionObs")}
                hint={t("settings.sectionObsHint")}
                search={search && !matches(t("settings.sectionObs") + " " + t("settings.labelObsHost") + " " + t("settings.labelObsPort") + " " + t("settings.labelObsPassword") + " " + t("settings.labelObsVerified"))}
                contentClassName=""
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-cs2-text-secondary">{t("settings.labelObsVerified")}</span>
                  <button
                    type="button"
                    onClick={() => void handleConfigCheck()}
                    disabled={checking}
                    className="shrink-0 flex items-center gap-1.5 rounded-lg border border-cs2-border bg-cs2-bg-input px-3 py-1.5 text-[11px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent disabled:opacity-50"
                  >
                    {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                    {checking ? t("obscfg.btnChecking") : t("obscfg.btnConfigCheck")}
                  </button>
                </div>
                {/* Check result status */}
                {checkResult && (
                  <div className="mb-2 flex items-center gap-2 text-[11px]">
                    {!checkResult.error && checkResult.path_ok && checkResult.connected ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-cs2-emerald-on-surface" />
                        <span className="text-cs2-emerald-on-surface">{t("obscfg.connOk")}</span>
                      </>
                    ) : checkResult.error ? (
                      <>
                        <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                        <span className="text-red-400 truncate">{checkResult.error}</span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                        <span className="text-amber-400">{!checkResult.path_ok ? t("obscfg.pathError") : t("obscfg.connFail")}</span>
                      </>
                    )}
                  </div>
                )}
                <div className="divide-y divide-cs2-border/40">
                  <FieldRow label={t("settings.labelObsHost")} search={search && !matches(t("settings.labelObsHost") + " " + (obs.host ?? ""))}>
                    <ObsHostField value={obs.host ?? "localhost"} onChange={(v) => set("obs.host", v)} />
                  </FieldRow>
                  <FieldRow label={t("settings.labelObsPort")} search={search && !matches(t("settings.labelObsPort") + " " + (obs.port ?? ""))}>
                    <NumberInput value={obs.port ?? 4455} onChange={(v) => set("obs.port", v)} min={1} max={65535} />
                  </FieldRow>
                  <FieldRow label={t("settings.labelObsPassword")} search={search && !matches(t("settings.labelObsPassword"))}>
                    <TextInput type="password" value={obs.password ?? ""} onChange={(v) => set("obs.password", v)} placeholder="OBS WebSocket password" />
                  </FieldRow>
                </div>
              </SectionCard>

              {/* OBS 校准 */}
              <SectionCard
                title={t("obscfg.sectionCalibrate")}
                hint={t("obscfg.calibrateDesc")}
                search={search && !matches(t("obscfg.sectionCalibrate") + " " + t("obscfg.rowCanvas") + " " + t("obscfg.rowOutput") + " " + t("obscfg.rowScene"))}
                contentClassName=""
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className={`inline-flex items-center gap-2 text-[11px] font-semibold ${status?.obs_connected ? "text-cs2-emerald-on-surface" : "text-cs2-rose-on-surface"}`}>
                    {status?.obs_connected ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
                    {status?.obs_connected ? t("obscfg.connOk") : t("obscfg.connFail")}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRefreshStatus()}
                    disabled={statusRefreshing}
                    className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-cs2-text-muted hover:text-cs2-text-primary disabled:opacity-40 transition-colors"
                  >
                    <RefreshCw className={`h-3 w-3 ${statusRefreshing ? "animate-spin" : ""}`} />
                    {t("obscfg.btnRefresh")}
                  </button>
                </div>

                {status?.obs_connected && (
                  <div className="mb-2 divide-y divide-cs2-border/40 rounded-lg border border-cs2-border/50 overflow-hidden text-[11px]">
                    {obsStatusRows(status).map((item, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                        <span className="w-20 shrink-0 text-cs2-text-muted">{item.label}</span>
                        <span className="flex-1 truncate font-mono text-cs2-text-secondary">{item.value}</span>
                        {item.skip ? (
                          <span className="text-cs2-text-muted">—</span>
                        ) : item.infoOnly ? (
                          item.outputPath ? (
                            <button
                              type="button"
                              title={t("obscfg.btnOpenFolderTitle")}
                              onClick={() => API.post("/open-folder", { path: item.outputPath }).catch(() => {})}
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-cs2-text-muted transition-colors hover:text-cs2-text-primary"
                            >
                              <FolderOpen className="h-3 w-3 shrink-0" />
                              {t("obscfg.btnOpenFolder")}
                            </button>
                          ) : (
                            <span className="text-cs2-text-muted">—</span>
                          )
                        ) : item.ok ? (
                          <span className="flex items-center gap-1 text-cs2-emerald-on-surface">
                            <CheckCircle2 className="h-3 w-3 shrink-0" />{t("obscfg.statusOk")}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-amber-400">
                            <AlertTriangle className="h-3 w-3 shrink-0" />{item.issue}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {(() => {
                  const rows = obsStatusRows(status);
                  const hasIssues = rows.some(r => !r.skip && !r.infoOnly && !r.ok);
                  return (
                    <button
                      type="button"
                      onClick={() => void handleCalibrate()}
                      disabled={calibrating || !status?.obs_connected || !hasIssues}
                      title={
                        !status?.obs_connected ? t("obscfg.btnTitleNotConnected") : !hasIssues ? t("obscfg.btnTitleAllOk") : ""
                      }
                      className={`mt-1 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-bold transition-colors ${
                        hasIssues && status?.obs_connected && !calibrating
                          ? "bg-cs2-accent text-cs2-bg-dark hover:bg-cs2-accent/80"
                          : "border border-cs2-border/50 bg-cs2-bg-input text-cs2-text-muted cursor-not-allowed opacity-50"
                      }`}
                    >
                      {calibrating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      {hasIssues ? t("obscfg.btnFix") : t("obscfg.btnNoIssues")}
                    </button>
                  );
                })()}

                {calibrateResult?.changed?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {calibrateResult.changed.map((msg, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-[11px] text-cs2-emerald-on-surface">
                        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />{msg}
                      </div>
                    ))}
                  </div>
                )}
                {calibrateResult?.restart_obs_required && (
                  <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/5 px-2.5 py-2 text-[11px] text-amber-400">
                    <RotateCcw className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{t("obscfg.restartRequired")}</span>
                  </div>
                )}
                {checkResult?.restart_obs_required && (
                  <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/5 px-2.5 py-2 text-[11px] text-amber-400">
                    <RotateCcw className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{t("obscfg.restartRequired")}</span>
                  </div>
                )}
              </SectionCard>
                </>
              ) : (
                (!search || matches(t("settings.obsAgentSearchTerms"))) && (
                  <ObsAiSettingsPanel
                    obsPath={obs.obs_path ?? ""}
                    obsConnected={Boolean(status?.obs_connected)}
                    ffmpegReady={Boolean(config.ffmpeg_path)}
                    autoPrepare={Boolean(config.obs_agent_auto_prepare)}
                    onAutoPrepareChange={(value) => set("obs_agent_auto_prepare", value)}
                  />
                )
              )}
            </div>
          )}

          {/* ======================== 解析设置 ======================== */}
          {activeTab === "parse" && (
            <div className="space-y-4">
              {/* Analysis Mode */}
              <SectionCard title={t("settings.sectionAnalysisMode")} hint={t("settings.sectionAnalysisModeHint")} search={search && !matches(t("settings.sectionAnalysisMode") + " " + t("settings.modeAi") + " " + t("settings.modeLocal"))}>
                <FieldRow search={search && !matches(t("settings.modeAi") + " " + t("settings.modeLocal"))}>
                  <div className="flex gap-2">
                    {[
                      { val: false, label: t("settings.modeLocal"), desc: t("settings.modeLocalDesc") },
                      { val: true, label: t("settings.modeAi"), desc: t("settings.modeAiDesc") },
                    ].map((m) => (
                      <button
                        key={String(m.val)}
                        type="button"
                        onClick={() => set("ai_mode", m.val)}
                        className={`flex-1 rounded-lg border p-3 text-left transition-colors ${
                          config.ai_mode === m.val
                            ? "border-cs2-accent/60 bg-cs2-accent/10"
                            : "border-cs2-border bg-cs2-bg-input/30 hover:border-cs2-accent/30"
                        }`}
                      >
                        <div className="text-xs font-semibold text-cs2-text-primary">{m.label}</div>
                        <div className="mt-0.5 text-[11px] text-cs2-text-muted">{m.desc}</div>
                      </button>
                    ))}
                  </div>
                </FieldRow>
              </SectionCard>

              {/* LLM */}
              {config.ai_mode && (
                <SectionCard title={t("settings.sectionLlm")} hint={t("settings.sectionLlmHint")} search={search && !matches(t("settings.sectionLlm") + " " + t("settings.labelLlmBaseUrl") + " " + t("settings.labelLlmModel") + " " + t("settings.labelLlmApiKey"))}>
                  {isLocalEndpoint && (
                    <div style={hide(t("settings.localEndpointHint"))} className="mb-3">
                      <div className="rounded-md border border-cs2-accent/30 bg-cs2-accent/5 px-3 py-2 text-[11px] text-cs2-accent">
                        {t("settings.localEndpointHint")}
                      </div>
                    </div>
                  )}
                  <FieldRow label={t("settings.labelLlmBaseUrl")} search={search && !matches(t("settings.labelLlmBaseUrl") + " " + (llm.base_url ?? ""))}>
                    <TextInput value={llm.base_url ?? ""} onChange={(v) => set("llm.base_url", v || null)} placeholder={t("settings.baseUrlPlaceholder")} />
                  </FieldRow>
                  <FieldRow label={t("settings.labelLlmModel")} search={search && !matches(t("settings.labelLlmModel") + " " + (llm.model ?? ""))}>
                    <TextInput value={llm.model ?? ""} onChange={(v) => set("llm.model", v)} placeholder={t("settings.modelPlaceholder")} />
                  </FieldRow>
                  <FieldRow label={t("settings.labelLlmApiKey")} hint={llm.api_key ? t("settings.apiKeySaved") : ""} search={search && !matches(t("settings.labelLlmApiKey"))}>
                    <TextInput type="password" value={llm.api_key ?? ""} onChange={(v) => set("llm.api_key", v)} placeholder={t("settings.apiKeyPlaceholderKeep")} />
                  </FieldRow>
                </SectionCard>
              )}

              {/* Players */}
              <SectionCard title={t("settings.sectionPlayers")} hint={t("settings.sectionPlayersHint")} search={search && !matches(t("settings.sectionPlayers") + " " + (config.expected_parse_players ?? []).join(" "))}>
                <FieldRow search={search && !matches(t("settings.sectionPlayers") + " players " + (config.expected_parse_players ?? []).join(" "))}>
                  <TagList
                    items={config.expected_parse_players ?? []}
                    onChange={(v) => set("expected_parse_players", v)}
                    placeholder={t("settings.playerInputPlaceholder")}
                    addLabel={t("settings.playerAddBtn")}
                    emptyLabel={t("settings.playersEmpty")}
                  />
                </FieldRow>
              </SectionCard>

              {/* Watch Paths */}
              <SectionCard title={t("settings.sectionWatchPaths")} hint={t("settings.sectionWatchPathsHint")} search={search && !matches(t("settings.sectionWatchPaths") + " " + (config.demo_watch_paths ?? []).join(" "))}>
                <FieldRow search={search && !matches(t("settings.sectionWatchPaths") + " " + (config.demo_watch_paths ?? []).join(" "))}>
                  <TagList
                    items={config.demo_watch_paths ?? []}
                    onChange={(v) => set("demo_watch_paths", v)}
                    placeholder="C:\\demos\\auto-watch"
                    addLabel={t("settings.sidebarWatchAdd")}
                    emptyLabel={t("settings.watchPathsEmpty")}
                  />
                </FieldRow>
              </SectionCard>

            </div>
          )}

          {/* ======================== 录制预设 ======================== */}
          {activeTab === "recording" && (
            <RecordingParamsPage
              embedded
              onRegisterSave={registerRecordingSave}
              onSaveUiChange={updateRecordingSaveUi}
            />
          )}

        </div>
      </div>

{/* Footer save bar */}
{
  <div className="shrink-0 px-4 pb-3 pt-2">
    <div
      data-testid="settings-save-footer-card"
      className={`flex items-center justify-between gap-4 rounded-[10px] border border-cs2-border bg-cs2-bg-card px-4 py-2.5 ${activeTab === "video" && aiObsRecommendationEnabled ? "w-full" : "mx-auto w-full max-w-6xl"}`}
    >
      <div className="min-w-0 flex-1">
        {activeTab !== "recording" && saveMsg && (
          <p className={`truncate text-[11px] ${saveMsg.tone === "ok" ? "text-cs2-emerald-on-surface" : "text-cs2-rose-on-surface"}`}>
            {saveMsg.text}
          </p>
        )}
              {activeTab !== "recording" && !saveMsg && <p className="text-xs text-cs2-text-muted">{t("settings.saveFooterDesc")}</p>}
              {activeTab === "recording" && <p className="text-xs text-cs2-text-muted">{t("record.commonSaveFooterDesc")}</p>}
            </div>
            {activeTab === "recording" ? (
              <button
          type="button"
          onClick={handleRecordingSave}
          disabled={recordingSaveUi.disabled}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[10px] bg-cs2-accent px-4 text-xs font-semibold text-cs2-text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
                {recordingSaveUi.state === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {recordingSaveUi.state === "saving" ? t("record.commonSaving") : recordingSaveUi.state === "saved" ? t("record.commonSaved") : t("record.commonSaveBtn")}
              </button>
            ) : (
              <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[10px] bg-cs2-accent px-4 text-xs font-semibold text-cs2-text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {t("settings.saveAllBtn")}
              </button>
            )}
          </div>
        </div>
      }
      {/* Sponsor Modal */}
      {showSponsorModal && <SponsorModal onClose={() => setShowSponsorModal(false)} />}
    </div>
  );
}
