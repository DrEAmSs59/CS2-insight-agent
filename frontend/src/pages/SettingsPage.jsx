import { useCallback, useEffect, useRef, useState } from "react";
import API from "../api/api";
import { calibrateObs, getObsConfigStatus } from "../api/obsConfigCenter";
import { useT } from "../i18n/useT.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import { useAppShell } from "../context/AppShellContext";
import RecordingParamsPage from "./RecordingParamsPage";
import SponsorModal from "../components/SponsorModal";
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

/* ---------------------------------------------------------------------------
 * Helper function to open external links in system default browser
 * ------------------------------------------------------------------------ */

function openExternalLink(url) {
  // Electron 环境：使用 shell.openExternal 打开系统默认浏览器
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
  } else {
    // 非 Electron 环境（浏览器）：使用 window.open
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/* ---------------------------------------------------------------------------
 * Reusable field-row primitives
 * ------------------------------------------------------------------------ */

function SectionCard({ title, hint, children, search, className }) {
  if (search) return null;
  return (
    <div className={`rounded-xl border border-cs2-border/70 bg-cs2-bg-card px-4 py-3.5 ${className ?? ""}`}>
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-cs2-text-secondary">{title}</h2>
        {hint && <span className="text-xs text-cs2-text-muted">{hint}</span>}
      </div>
      <div className="divide-y divide-cs2-border/40">
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

function Toggle({ value, onChange, onLabel, offLabel }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
          value ? "bg-cs2-accent" : "bg-cs2-bg-input"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
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
            setDetecting(false);
            return; // 检测成功，不再打开文件选择对话框
          }
        } catch {
          // 检测失败，继续打开文件选择对话框
        } finally {
          setDetecting(false);
        }
      }
    }

    // 使用 Electron 的文件选择对话框（如果可用）
    if (window.electron?.showOpenDialog) {
      try {
        // 如果已有值，使用完整路径作为 defaultPath（预定位并预选择该文件）
        const defaultPath = value && value.trim() ? value : "";

        const result = await window.electron.showOpenDialog({
          title: `选择 ${exeName}`,
          defaultPath: defaultPath || undefined,
          filters: [{ name: exeName, extensions: ['exe'] }],
          properties: ['openFile']
        });

        if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
          onChange(result.filePaths[0]);
        }
      } catch (e) {
        console.error('Electron dialog error:', e);
        // Electron 对话框失败，fallback 到 HTML file input
        fileRef.current?.click();
      }
    } else {
      // 非 Electron 环境，使用 HTML file input
      fileRef.current?.click();
    }
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
      {/* Fallback file input for non-Electron environments */}
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

function TagList({ items, onChange, placeholder, addLabel }) {
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
        {items.length === 0 && <span className="text-[11px] text-cs2-text-muted">尚未添加玩家</span>}
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
function formatLastCheckTime(isoUtc) {
  if (!isoUtc) return "";
  try {
    const d = new Date(isoUtc);
    if (isNaN(d.getTime())) return isoUtc;
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;
    if (diffDay < 7) return `${diffDay} 天前`;
    // 超过一周显示具体日期
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

const MIRROR_OPTIONS = [
  { value: "auto", key: "settings.mirrorAuto" },
  { value: "on", key: "settings.mirrorOn" },
  { value: "off", key: "settings.mirrorOff" },
];

const UPDATE_FREQUENCY_OPTIONS = [
  { value: "weekly", key: "settings.updateFreqWeekly" },
  { value: "monthly", key: "settings.updateFreqMonthly" },
  { value: "never", key: "settings.updateFreqNever" },
];

/* ---------------------------------------------------------------------------
 * Tab definitions
 * ------------------------------------------------------------------------ */
const TABS = [
  { key: "general", icon: FolderOpen, labelKey: "settings.tabGeneral" },
  { key: "parse", icon: Brain, labelKey: "settings.tabParse" },
  { key: "video", icon: Monitor, labelKey: "settings.tabVideo" },
  { key: "recording", icon: SlidersHorizontal, labelKey: "settings.tabRecording" },
];

/* ---------------------------------------------------------------------------
 * Main page
 * ------------------------------------------------------------------------ */

export default function SettingsPage() {
  const t = useT();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("general");
  const [dataDirInfo, setDataDirInfo] = useState(null);
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

  // Get app version (Electron only, fallback to "dev")
  const [appVersion, setAppVersion] = useState("dev");
  useEffect(() => {
    if (window.electron?.getVersion) {
      window.electron.getVersion().then((v) => {
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
      payload.locale = config.locale ?? "zh";
      payload.demo_directory = config.demo_directory ?? "";
      payload.demo_watch_paths = config.demo_watch_paths ?? [];
      payload.expected_parse_players = config.expected_parse_players ?? [];
      payload.update_github_mirror = config.update_github_mirror ?? "auto";
      payload.update_check_frequency = config.update_check_frequency ?? "weekly";
      payload.steam_api_key = config.steam_api_key ?? "";
      payload.steam_id64 = config.steam_id64 ?? "";
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
        <div className={activeTab === "recording" ? "flex min-h-0 flex-1 flex-col" : "mx-auto max-w-4xl px-4 pb-24 pt-2"}>

          {/* ======================== 通用设置 ======================== */}
          {activeTab === "general" && (
            <div className="space-y-4">
              {/* System + Language */}
              <SectionCard title={t("settings.sectionSystem")} hint={t("settings.sectionSystemHint")} search={search && !matches(t("settings.sectionSystem") + " " + t("settings.currentVersion") + " " + t("settings.labelUpdateMirror"))}>
                <FieldRow label={t("settings.currentVersion")} search={search && !matches(t("settings.currentVersion") + " version")}>
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-cs2-text-primary font-mono">{appVersion}</p>
                    {config.last_update_check_at && (
                      <span className="text-xs text-cs2-text-muted">
                        ({t("settings.lastCheckTime")}: {formatLastCheckTime(config.last_update_check_at)})
                      </span>
                    )}
                  </div>
                </FieldRow>
                <FieldRow label={t("settings.labelUpdateFrequency")} hint={t("settings.hintUpdateFrequency")} search={search && !matches(t("settings.labelUpdateFrequency"))}>
                  <SelectInput
                    value={config.update_check_frequency ?? "weekly"}
                    onChange={(v) => set("update_check_frequency", v)}
                    options={UPDATE_FREQUENCY_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
                  />
                </FieldRow>
                <FieldRow label={t("settings.labelUpdateMirror")} search={search && !matches(t("settings.labelUpdateMirror") + " mirror")}>
                  <div className="flex gap-2">
                    <SelectInput
                      value={config.update_github_mirror ?? "auto"}
                      onChange={(v) => set("update_github_mirror", v)}
                      options={MIRROR_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
                      className="flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => void shell.fetchUpdateInfo({ force: true, manual: true })}
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
                    onClick={() => openExternalLink('https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=bug_report.yml')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <Bug className="h-3.5 w-3.5" />
                    {t("settings.btnReportBug")}
                  </button>
                  <button
                    type="button"
                    onClick={() => openExternalLink('https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=feature_request.yml')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-xs font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent"
                  >
                    <Lightbulb className="h-3.5 w-3.5" />
                    {t("settings.btnRequestFeature")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const locale = useLocaleStore.getState().locale;
                      const subject = locale === 'zh' ? 'CS2-Insight-Agent 联系' : 'CS2-Insight-Agent Contact';
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
                <FieldRow label={t("settings.labelLocale")} search={search && !matches(t("settings.labelLocale") + " " + t("settings.localeZh"))}>
                  <SelectInput
                    value={config.locale ?? "zh"}
                    onChange={(v) => {
                      set("locale", v);
                      useLocaleStore.getState().setLocale(v);
                    }}
                    options={[
                      { value: "zh", label: t("settings.localeZh") },
                      { value: "en", label: t("settings.localeEn") },
                    ]}
                  />
                </FieldRow>
              </SectionCard>

              {/* Paths (CS2 + Demo Directory only) */}
              <SectionCard title={t("settings.sectionPaths")} hint={t("settings.sectionPathsHint")} search={search && !matches(t("settings.sectionPaths") + " " + t("settings.labelCs2Path") + " " + t("settings.labelDataDirectory"))}>
                <FieldRow label={t("settings.labelCs2Path")} hint={t("settings.hintCs2Path")} search={search && !matches(t("settings.labelCs2Path") + " " + (config.cs2_path ?? ""))}>
                  <PathPicker
                    value={config.cs2_path ?? ""}
                    onChange={(v) => set("cs2_path", v)}
                    placeholder="cs2.exe"
                    exeName="cs2.exe"
                    detectApi="/api/config/detect-cs2"
                    detectField="cs2_path"
                    t={t}
                  />
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
              </SectionCard>

              {/* Player Game Config */}
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
                  <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-emerald-200">{t("playercfg.okTitle")}</p>
                        <p className="mt-1 text-xs leading-relaxed text-emerald-100/80">{t("playercfg.okDesc")}</p>
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
            </div>
          )}

          {/* ======================== 视频设置 ======================== */}
          {activeTab === "video" && (
            <div className="space-y-4">
              {/* Paths: OBS + FFmpeg */}
              <SectionCard title={t("settings.sectionPaths")} hint={t("settings.sectionPathsHint")} search={search && !matches(t("settings.sectionPaths") + " " + t("settings.labelObsPath") + " " + t("settings.labelFfmpegPath"))}>
                <FieldRow label={t("settings.labelObsPath")} hint={t("settings.hintObsPath")} search={search && !matches(t("settings.labelObsPath") + " " + (obs.obs_path ?? ""))}>
                  <PathPicker
                    value={obs.obs_path ?? ""}
                    onChange={(v) => set("obs.obs_path", v)}
                    placeholder="obs64.exe"
                    exeName="obs64.exe"
                    detectApi="/api/config/detect-obs"
                    detectField="obs_path"
                    t={t}
                  />
                </FieldRow>
                <FieldRow label={t("settings.labelFfmpegPath")} hint={t("settings.hintFfmpegPath")} search={search && !matches(t("settings.labelFfmpegPath") + " " + (config.ffmpeg_path ?? ""))}>
                  <PathPicker
                    value={config.ffmpeg_path ?? ""}
                    onChange={(v) => set("ffmpeg_path", v)}
                    placeholder="ffmpeg.exe"
                    exeName="ffmpeg.exe"
                    detectApi="/api/config/detect-ffmpeg"
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

              {/* OBS connection */}
              <SectionCard title={t("settings.sectionObs")} hint={t("settings.sectionObsHint")} search={search && !matches(t("settings.sectionObs") + " " + t("settings.labelObsHost") + " " + t("settings.labelObsPort") + " " + t("settings.labelObsPassword") + " " + t("settings.labelObsVerified"))}>
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
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
                        <span className="text-green-400">{t("obscfg.connOk")}</span>
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
                <FieldRow label={t("settings.labelObsHost")} search={search && !matches(t("settings.labelObsHost") + " " + (obs.host ?? ""))}>
                  <TextInput value={obs.host ?? "localhost"} onChange={(v) => set("obs.host", v)} />
                </FieldRow>
                <FieldRow label={t("settings.labelObsPort")} search={search && !matches(t("settings.labelObsPort") + " " + (obs.port ?? ""))}>
                  <NumberInput value={obs.port ?? 4455} onChange={(v) => set("obs.port", v)} min={1} max={65535} />
                </FieldRow>
                <FieldRow label={t("settings.labelObsPassword")} search={search && !matches(t("settings.labelObsPassword"))}>
                  <TextInput type="password" value={obs.password ?? ""} onChange={(v) => set("obs.password", v)} placeholder="OBS WebSocket password" />
                </FieldRow>
              </SectionCard>

              {/* OBS 校准 */}
              <SectionCard title={t("obscfg.sectionCalibrate")} hint={t("obscfg.calibrateDesc")} search={search && !matches(t("obscfg.sectionCalibrate") + " " + t("obscfg.rowCanvas") + " " + t("obscfg.rowOutput") + " " + t("obscfg.rowScene"))}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] text-cs2-text-muted">{status?.obs_connected ? t("obscfg.connOk") : t("obscfg.connFail")}</span>
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
                          <span className="flex items-center gap-1 text-green-400">
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
                      <div key={i} className="flex items-start gap-1.5 text-[11px] text-green-400">
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
        <div className="shrink-0 border-t border-cs2-border/60 bg-cs2-bg/90 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              {activeTab !== "recording" && saveMsg && (
                <p className={`truncate text-[11px] ${saveMsg.tone === "ok" ? "text-green-400" : "text-red-400"}`}>
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
                className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-cs2-accent px-4 py-2 text-xs font-semibold text-cs2-bg-dark transition-colors hover:bg-cs2-accent/80 disabled:opacity-50"
              >
                {recordingSaveUi.state === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {recordingSaveUi.state === "saving" ? t("record.commonSaving") : recordingSaveUi.state === "saved" ? t("record.commonSaved") : t("record.commonSaveBtn")}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-cs2-accent px-4 py-2 text-xs font-semibold text-cs2-bg-dark transition-colors hover:bg-cs2-accent/80 disabled:opacity-50"
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
