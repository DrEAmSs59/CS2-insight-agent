import RecordingSectionMenu from "../components/recordingQueue/RecordingSectionMenu.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import API from "../api/api";
import { calibrateObs, getObsConfigStatus } from "../api/obsConfigCenter";
import { useT } from "../i18n/useT.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import { useAppShell } from "../context/AppShellContext";
import { desktopBridge } from "../desktop/desktopBridge.js";
import RecordingParamsPage from "./RecordingParamsPage";
import ObsHostField from "../components/settings/ObsHostField.jsx";
import GameResourcesSettings from "../components/settings/GameResourcesSettings.jsx";
import { backgrounds } from "../features/cosmetics-workshop/lucasBackgrounds.js";
import { saveLucasBackground, useLucasBackground } from "../features/cosmetics-workshop/lucasAppearance.js";
import { displayVersion } from "../utils/appVersion.js";
import { formatFileSize } from "../utils/demoLibraryDisplay.js";
import { countChangedFields } from "../utils/settingsDiff.js";
import { readShowGuideOnStartup, saveShowGuideOnStartup } from "../utils/startupPreferences.js";
import { formatObsEncoderLabel, obsEncoderIsConfigured, obsEncoderIsHardware } from "../utils/obsEncoderDisplay.js";
import { NumberInput, PathPicker, Segmented, SelectInput, SettingsButton, SettingsGroup, SettingsNote, SettingsPageHeader, SettingsRow, SizeLabel, StatusText, Switch, TagList, TextInput } from "./settings/SettingsControls.jsx";
import { RECORDING_PRESET_SECTIONS } from "./settings/recordingPresetSections.js";
import { Settings as SettingsIcon, Search, Loader2, Check, CheckCircle2, XCircle, SlidersHorizontal, Cpu, FolderOpen, Monitor, AlertTriangle, RefreshCw, RotateCcw, ShieldAlert, PackageOpen, Info, Download, ExternalLink, X } from "lucide-react";

// The AI insight mode remains available for demo review, but OBS recommendation
// is intentionally kept behind a local release gate until the workflow is ready.
const AI_OBS_RECOMMENDATION_ENABLED = false;
function openExternalLink(url) {
  if (desktopBridge) {
    void desktopBridge.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
const ISSUE_TEMPLATE_URLS = {
  zh: {
    bug: "https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=bug_report.yml",
    feature: "https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=feature_request.yml"
  },
  en: {
    bug: "https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=bug_report_en.yml",
    feature: "https://github.com/DrEAmSs59/CS2-insight-agent/issues/new?template=feature_request_en.yml"
  }
};
function openIssueTemplate(type) {
  const {
    effectiveLocale
  } = useLocaleStore.getState();
  openExternalLink(ISSUE_TEMPLATE_URLS[effectiveLocale]?.[type] ?? ISSUE_TEMPLATE_URLS.zh[type]);
}

// ISO 8601 UTC -> relative local time
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
    if (diffMin < 60) return t("settings.timeMinutesAgo", {
      n: diffMin
    });
    if (diffHour < 24) return t("settings.timeHoursAgo", {
      n: diffHour
    });
    if (diffDay < 7) return t("settings.timeDaysAgo", {
      n: diffDay
    });
    const dateLocale = locale === "zh" ? "zh-CN" : "en";
    return d.toLocaleDateString(dateLocale) + " " + d.toLocaleTimeString(dateLocale, {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return isoUtc;
  }
}
const ENCODER_OPTIONS = [{
  value: "auto",
  key: "settings.encoderAuto"
}, {
  value: "h264_nvenc",
  key: "settings.encoderNvenc"
}, {
  value: "h264_qsv",
  key: "settings.encoderQsv"
}, {
  value: "h264_amf",
  key: "settings.encoderAmf"
}, {
  value: "libx264",
  key: "settings.encoderX264"
}];

/* ---------------------------------------------------------------------------
 * Navigation
 * ------------------------------------------------------------------------ */
const NAV_GROUPS = [{
  labelKey: "settings.navGroupGeneral",
  items: [{
    key: "general",
    icon: SettingsIcon,
    labelKey: "settings.tabGeneral",
    descKey: "settings.pageDescGeneral"
  }, {
    key: "paths",
    icon: FolderOpen,
    labelKey: "settings.tabPaths",
    descKey: "settings.pageDescPaths"
  }, {
    key: "about",
    icon: Info,
    labelKey: "settings.tabAbout",
    descKey: "settings.pageDescAbout"
  }]
}, {
  labelKey: "settings.navGroupRecording",
  items: [{
    key: "recording",
    icon: SlidersHorizontal,
    labelKey: "settings.tabRecording"
  }, {
    key: "video",
    icon: Monitor,
    labelKey: "settings.tabVideo",
    descKey: "settings.pageDescVideo"
  }]
}, {
  labelKey: "settings.navGroupAnalysis",
  items: [{
    key: "parse",
    icon: Cpu,
    labelKey: "settings.tabParse",
    descKey: "settings.pageDescParse"
  }]
}, {
  labelKey: "settings.navGroupResources",
  items: [{
    key: "game-resources",
    icon: PackageOpen,
    labelKey: "settings.tabGameResources",
    descKey: "settings.pageDescGameResources"
  }]
}];
const ALL_TABS = NAV_GROUPS.flatMap(group => group.items);
const VALID_TAB_KEYS = new Set(ALL_TABS.map(tab => tab.key));
// These tabs save on their own, so the page-level save bar never appears there.
const SELF_SAVING_TABS = new Set(["game-resources", "about"]);
function resolveTabFromSearch(searchParams) {
  const tab = searchParams.get("tab");
  return tab && VALID_TAB_KEYS.has(tab) ? tab : "general";
}
function buildConfigPayload(config) {
  const obs = config.obs ?? {};
  const llm = config.llm ?? {};
  return {
    cs2_path: config.cs2_path ?? "",
    ffmpeg_path: config.ffmpeg_path ?? "",
    montage_encoder: config.montage_encoder ?? "auto",
    ai_mode: !!config.ai_mode,
    obs_agent_auto_prepare: !!config.obs_agent_auto_prepare,
    locale: config.locale ?? "auto",
    demo_directory: config.demo_directory ?? "",
    demo_cache_directory: config.demo_cache_directory ?? "",
    demo_watch_paths: config.demo_watch_paths ?? [],
    expected_parse_players: config.expected_parse_players ?? [],
    steam_api_key: config.steam_api_key ?? "",
    steam_id64: config.steam_id64 ?? "",
    steam_cdn_assets_enabled: config.steam_cdn_assets_enabled !== false,
    match_mode: config.match_mode ?? "premier",
    match_count: config.match_count ?? 20,
    obs: {
      host: obs.host ?? "localhost",
      port: obs.port ?? 4455,
      password: obs.password ?? "",
      obs_path: obs.obs_path ?? ""
    },
    llm: {
      base_url: llm.base_url ?? null,
      model: llm.model ?? "",
      api_key: llm.api_key ?? "",
      provider: llm.provider ?? ""
    }
  };
}
function MessageText({
  message
}) {
  if (!message) return null;
  const tone = message.tone === "error" ? "text-cs2-rose-on-surface" : message.tone === "warn" ? "text-cs2-amber-on-surface" : "text-cs2-emerald-on-surface";
  return <p className={`w-full text-xs ${tone}`}>{message.text}</p>;
}

/* ---------------------------------------------------------------------------
 * Main page
 * ------------------------------------------------------------------------ */

export default function SettingsPage() {
  const t = useT();
  const effectiveLocale = useLocaleStore(state => state.effectiveLocale);
  const [searchParams] = useSearchParams();
  const [config, setConfig] = useState(null);
  const [savedConfig, setSavedConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState(() => resolveTabFromSearch(searchParams));
  const [activeSection, setActiveSection] = useState(RECORDING_PRESET_SECTIONS[0].id);
  const scrollRef = useRef(null);
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
  const background = useLucasBackground();
  const [backgroundFailed, setBackgroundFailed] = useState(false);
  const [showGuideOnStartup, setShowGuideOnStartup] = useState(readShowGuideOnStartup);
  const [startupGuideFailed, setStartupGuideFailed] = useState(false);
  const recordingSaveRef = useRef(null);
  const recordingDiscardRef = useRef(null);
  const [recordingSaveUi, setRecordingSaveUi] = useState({
    disabled: true,
    state: "idle",
    changes: 0,
    error: ""
  });
  const registerRecordingSave = useCallback(save => {
    recordingSaveRef.current = save;
  }, []);
  const registerRecordingDiscard = useCallback(discard => {
    recordingDiscardRef.current = discard;
  }, []);
  const updateRecordingSaveUi = useCallback(next => {
    setRecordingSaveUi(prev => prev.disabled === next.disabled && prev.state === next.state && prev.changes === (next.changes ?? 0) && prev.error === (next.error ?? "") ? prev : {
      disabled: next.disabled,
      state: next.state,
      changes: next.changes ?? 0,
      error: next.error ?? ""
    });
  }, []);

  // OBS Config Check / Calibrate
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [status, setStatus] = useState(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrateResult, setCalibrateResult] = useState(null);
  const [restartAlertDismissed, setRestartAlertDismissed] = useState(false);
  const shell = useAppShell();
  const playerConfigLoading = shell.configBackupLoading;
  const playerConfigStatus = shell.configBackupStatus;
  useEffect(() => {
    setActiveTab(resolveTabFromSearch(searchParams));
  }, [searchParams]);
  const selectTab = useCallback(key => {
    setActiveTab(key);
    setActiveSection(RECORDING_PRESET_SECTIONS[0].id);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, []);

  // Section clicked in the preset menu; scroll spying pauses until that scroll ends.
  const jumpTargetRef = useRef(null);
  const jumpToSection = useCallback(id => {
    const container = scrollRef.current;
    const el = document.getElementById(id);
    setActiveSection(id);
    if (!container || !el) return;
    // Scroll only the settings pane. scrollIntoView would also scroll the app's
    // overflow-hidden workspace when the last sections cannot reach the top.
    const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top = Math.min(container.scrollTop + offset - 16, container.scrollHeight - container.clientHeight);
    if (Math.abs(top - container.scrollTop) < 1) return;
    jumpTargetRef.current = {
      id,
      until: Date.now() + 1500
    };
    container.scrollTo?.({
      top,
      behavior: "smooth"
    });
  }, []);

  // Highlight the recording preset section currently at the top of the scroll area.
  useEffect(() => {
    if (activeTab !== "recording") return undefined;
    const container = scrollRef.current;
    if (!container) return undefined;
    let frame = 0;
    const sync = () => {
      frame = 0;
      if (jumpTargetRef.current && Date.now() < jumpTargetRef.current.until) return;
      jumpTargetRef.current = null;
      const box = container.getBoundingClientRect();
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      const top = box.top + 96;
      let current = RECORDING_PRESET_SECTIONS[0].id;
      for (const section of RECORDING_PRESET_SECTIONS) {
        const el = document.getElementById(section.id);
        if (!el) continue;
        const sectionTop = el.getBoundingClientRect().top;
        // Short trailing sections never reach the top; at the end, the last visible one wins.
        if (sectionTop <= top || atBottom && sectionTop < box.bottom) current = section.id;
      }
      setActiveSection(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    // Keep the clicked section highlighted until the user scrolls again.
    const endJump = () => {
      if (!jumpTargetRef.current) return;
      jumpTargetRef.current = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const userScroll = ["wheel", "touchstart", "keydown", "pointerdown"];
    container.addEventListener("scroll", onScroll, {
      passive: true
    });
    container.addEventListener("scrollend", endJump);
    userScroll.forEach(type => container.addEventListener(type, endJump, {
      passive: true
    }));
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("scrollend", endJump);
      userScroll.forEach(type => container.removeEventListener(type, endJump));
      if (frame) cancelAnimationFrame(frame);
      jumpTargetRef.current = null;
    };
  }, [activeTab]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {
          data
        } = await API.get("config");
        if (!cancelled) {
          setConfig(data);
          setSavedConfig(data);
        }
      } catch (e) {
        if (!cancelled) console.error("Failed to load config:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    API.get("demo/replay/cache").then(({
      data
    }) => {
      if (!cancelled) setReplayCacheInfo(data);
    }).catch(error => {
      if (!cancelled) console.error("Failed to load replay cache info:", error);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const clearReplayCache = useCallback(async () => {
    if (replayCacheBusy || !window.confirm(t("settings.replayCacheConfirm"))) return;
    setReplayCacheBusy(true);
    setReplayCacheMsg(null);
    try {
      const {
        data
      } = await API.delete("demo/replay/cache");
      setReplayCacheInfo(data?.cache ?? null);
      setReplayCacheMsg({
        tone: "ok",
        text: t("settings.replayCacheCleared", {
          size: formatFileSize(Number(data?.removed_bytes) || 0)
        })
      });
      const {
        data: nextDataDirInfo
      } = await API.get("config/data-dir-info");
      setDataDirInfo(nextDataDirInfo);
    } catch (error) {
      setReplayCacheMsg({
        tone: "error",
        text: error.response?.data?.detail || error.message || t("settings.replayCacheFailed")
      });
    } finally {
      setReplayCacheBusy(false);
    }
  }, [replayCacheBusy, t]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {
          data
        } = await API.get("demo-cache");
        if (!cancelled) {
          setDemoCacheInfo(data);
          setDemoCacheDraft(data?.path ?? "");
        }
      } catch (e) {
        if (!cancelled) console.error("Failed to load demo cache info:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The background applies as soon as it changes and is kept on this device.
  const changeBackground = useCallback(value => {
    try {
      saveLucasBackground(value);
      setBackgroundFailed(false);
    } catch {
      setBackgroundFailed(true);
    }
  }, []);
  const changeShowGuideOnStartup = useCallback(value => {
    try {
      saveShowGuideOnStartup(value);
      setShowGuideOnStartup(value);
      setStartupGuideFailed(false);
    } catch {
      setStartupGuideFailed(true);
    }
  }, []);
  const browseDirectory = useCallback(async current => {
    if (desktopBridge) return desktopBridge.chooseDirectory(current);
    const {
      data
    } = await API.post("directory-picker");
    return data?.path ?? "";
  }, []);
  const browseDemoCache = useCallback(async () => {
    try {
      const selected = await browseDirectory(demoCacheDraft);
      if (selected) {
        setDemoCacheDraft(selected);
        setDemoCacheMsg(null);
      }
    } catch (e) {
      setDemoCacheMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message
      });
    }
  }, [browseDirectory, demoCacheDraft]);

  // Directory migrations persist on the backend immediately; keep the saved
  // snapshot in step so they never show up as unsaved changes.
  const applyPersistedConfig = useCallback(patch => {
    setConfig(prev => prev ? {
      ...prev,
      ...patch
    } : prev);
    setSavedConfig(prev => prev ? {
      ...prev,
      ...patch
    } : prev);
  }, []);
  const migrateDemoCache = useCallback(async () => {
    const destination = demoCacheDraft.trim();
    if (!destination || demoCacheBusy) return;
    if (!window.confirm(t("settings.demoCacheMigrateConfirm"))) return;
    setDemoCacheBusy(true);
    setDemoCacheMsg(null);
    try {
      const {
        data
      } = await API.post("demo-cache/migrate", {
        destination
      });
      setDemoCacheInfo(prev => ({
        ...(prev || {}),
        ...data,
        custom: true
      }));
      setDemoCacheDraft(data.path || destination);
      applyPersistedConfig({
        demo_cache_directory: data.path || destination
      });
      setDemoCacheMsg({
        tone: "ok",
        text: data.unchanged ? t("settings.demoCacheUnchanged") : t("settings.demoCacheMigrateSuccess", {
          moved: data.moved ?? 0,
          updated: data.db_updated ?? 0
        })
      });
    } catch (e) {
      setDemoCacheMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message || t("settings.demoCacheMigrateFailed")
      });
    } finally {
      setDemoCacheBusy(false);
    }
  }, [applyPersistedConfig, demoCacheBusy, demoCacheDraft, t]);
  const clearDemoCache = useCallback(async () => {
    if (demoCacheBusy || !window.confirm(t("settings.demoCacheClearConfirm"))) return;
    setDemoCacheBusy(true);
    setDemoCacheMsg(null);
    try {
      const {
        data
      } = await API.post("demo-cache/clear");
      const {
        data: next
      } = await API.get("demo-cache");
      setDemoCacheInfo(next);
      setDemoCacheDraft(next?.path ?? demoCacheDraft);
      setDemoCacheMsg({
        tone: "ok",
        text: t("settings.demoCacheClearSuccess", {
          files: data.removed_files ?? 0,
          demos: data.demos_invalidated ?? 0
        })
      });
    } catch (e) {
      setDemoCacheMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message || t("settings.demoCacheClearFailed")
      });
    } finally {
      setDemoCacheBusy(false);
    }
  }, [demoCacheBusy, demoCacheDraft, t]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {
          data
        } = await API.get("lite-cut/storage");
        if (!cancelled) {
          setLiteCutStorage(data);
          setLiteCutStorageDraft(data?.path ?? "");
        }
      } catch (e) {
        if (!cancelled) console.error("Failed to load LiteCut storage info:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const browseLiteCutStorage = useCallback(async () => {
    try {
      const selected = await browseDirectory(liteCutStorageDraft);
      if (selected) {
        setLiteCutStorageDraft(selected);
        setLiteCutStorageMsg(null);
      }
    } catch (e) {
      setLiteCutStorageMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message
      });
    }
  }, [browseDirectory, liteCutStorageDraft]);
  const migrateLiteCutStorage = useCallback(async () => {
    const destination = liteCutStorageDraft.trim();
    if (!destination || liteCutStorageBusy) return;
    if (!window.confirm(t("settings.liteCutStorageConfirm"))) return;
    setLiteCutStorageBusy(true);
    setLiteCutStorageMsg(null);
    try {
      let {
        data
      } = await API.post("lite-cut/storage/migrate", {
        destination
      });
      setLiteCutStorageJob(data);
      while (data?.job_id && ["queued", "running", "cancelling"].includes(data?.status)) {
        await new Promise(resolve => setTimeout(resolve, 500));
        ({
          data
        } = await API.get(`lite-cut/storage/migrate/${data.job_id}`));
        setLiteCutStorageJob(data);
      }
      if (data?.status === "cancelled") {
        setLiteCutStorageDraft(data.path || liteCutStorage?.path || destination);
        setLiteCutStorageMsg({
          tone: "warn",
          text: data.error || t("settings.liteCutStorageCancelled")
        });
        return;
      }
      if (data?.status !== "done") throw new Error(data?.error || t("settings.liteCutStorageFailed"));
      setLiteCutStorage(prev => ({
        ...(prev || {}),
        ...data,
        custom: data.path !== prev?.default_path
      }));
      setLiteCutStorageDraft(data.path);
      applyPersistedConfig({
        lite_cut_assets_dir: data.path
      });
      setLiteCutStorageMsg({
        tone: data.warning ? "warn" : "ok",
        text: data.warning || t("settings.liteCutStorageSuccess")
      });
    } catch (e) {
      setLiteCutStorageMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message || t("settings.liteCutStorageFailed")
      });
    } finally {
      setLiteCutStorageBusy(false);
      setLiteCutStorageJob(null);
    }
  }, [applyPersistedConfig, liteCutStorage?.path, liteCutStorageBusy, liteCutStorageDraft, t]);
  const cancelLiteCutStorageMigration = useCallback(async () => {
    if (!liteCutStorageJob?.job_id || !liteCutStorageBusy) return;
    try {
      const {
        data
      } = await API.delete(`lite-cut/storage/migrate/${liteCutStorageJob.job_id}`);
      setLiteCutStorageJob(data);
    } catch (e) {
      setLiteCutStorageMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message
      });
    }
  }, [liteCutStorageBusy, liteCutStorageJob?.job_id]);

  // Clearing only drops regenerable preview files; imported media and projects stay.
  const clearLiteCutStorage = useCallback(async () => {
    if (liteCutStorageBusy || !window.confirm(t("settings.liteCutStorageClearConfirm"))) return;
    setLiteCutStorageBusy(true);
    setLiteCutStorageMsg(null);
    try {
      const {
        data
      } = await API.post("lite-cut/proxy-cache/clear");
      const {
        data: next
      } = await API.get("lite-cut/storage");
      setLiteCutStorage(next);
      setLiteCutStorageMsg({
        tone: "ok",
        text: t("settings.liteCutStorageCleared", {
          files: data.removed_files ?? 0,
          size: formatFileSize(Number(data.removed_bytes) || 0)
        })
      });
    } catch (e) {
      setLiteCutStorageMsg({
        tone: "error",
        text: e.response?.data?.detail || e.message || t("settings.liteCutStorageClearFailed")
      });
    } finally {
      setLiteCutStorageBusy(false);
    }
  }, [liteCutStorageBusy, t]);
  // The desktop shell reports the Tauri version; browser previews use the Vite build version.
  const [appVersion, setAppVersion] = useState(__APP_VERSION__);
  useEffect(() => {
    if (desktopBridge) {
      desktopBridge.getVersion().then(v => {
        if (v) setAppVersion(displayVersion(v));
      }).catch(() => {});
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {
          data
        } = await API.get("config/data-dir-info");
        if (!cancelled) setDataDirInfo(data);
      } catch (e) {
        if (!cancelled) console.error("Failed to load data dir info:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    void shell.refreshConfigBackupStatus();
  }, [shell.refreshConfigBackupStatus]);

  // Deep-set helper
  const set = useCallback((path, value) => {
    setSaveMsg(null);
    setConfig(prev => {
      if (!prev) return prev;
      const next = {
        ...prev
      };
      const parts = path.split(".");
      let cur = next;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = {
          ...(cur[parts[i]] ?? {})
        };
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  }, []);
  const pendingChanges = useMemo(() => config && savedConfig ? countChangedFields(buildConfigPayload(config), buildConfigPayload(savedConfig)) : 0, [config, savedConfig]);
  useEffect(() => {
    if (!savedFlash) return undefined;
    const timer = setTimeout(() => setSavedFlash(false), 2200);
    return () => clearTimeout(timer);
  }, [savedFlash]);

  // ─── Save handler (defined early because handleCalibrate depends on it) ───

  const handleSave = useCallback(async () => {
    if (!config || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const payload = buildConfigPayload(config);
      await API.put("config", payload);
      useLocaleStore.getState().hydrate(payload.locale);
      setSavedConfig(config);
      setSavedFlash(true);
    } catch (e) {
      setSaveMsg({
        text: e.response?.data?.detail || e.message || "Save failed",
        tone: "error"
      });
    } finally {
      setSaving(false);
    }
  }, [config, saving]);
  const handleDiscard = useCallback(() => {
    if (!savedConfig) return;
    setConfig(savedConfig);
    setSaveMsg(null);
  }, [savedConfig]);

  // ─── OBS Config Check / Calibrate ──────────────────────────────

  const fetchObsStatus = useCallback(async () => {
    const st = await getObsConfigStatus();
    setStatus(st);
  }, []);
  const refreshStatusSilent = useCallback(async () => {
    try {
      await fetchObsStatus();
    } catch {/* silent */}
  }, [fetchObsStatus]);
  const handleConfigCheck = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    setRestartAlertDismissed(false);
    try {
      const obs = config.obs ?? {};
      const {
        data
      } = await API.post("/obs/config-check", {
        host: obs.host ?? "localhost",
        port: obs.port ?? 4455,
        password: obs.password ?? "",
        obs_path: obs.obs_path ?? ""
      });
      setCheckResult(data);
      if (data.connected) {
        await fetchObsStatus();
      }
    } catch (e) {
      setCheckResult({
        error: e.response?.data?.detail || e.message || t("obscfg.errorCheckFail")
      });
    } finally {
      setChecking(false);
    }
  }, [config, fetchObsStatus, t]);
  const handleCalibrate = useCallback(async () => {
    setCalibrating(true);
    setCalibrateResult(null);
    setRestartAlertDismissed(false);
    try {
      // Save first so the backend config has the latest OBS connection params
      await handleSave();
      const data = await calibrateObs();
      setCalibrateResult(data);
      await refreshStatusSilent();
    } catch (e) {
      setCalibrateResult({
        error: e.response?.data?.detail || e.message || t("obscfg.errorCalibrateFail")
      });
    } finally {
      setCalibrating(false);
    }
  }, [handleSave, refreshStatusSilent, t]);
  const handleRefreshStatus = useCallback(async () => {
    setStatusRefreshing(true);
    try {
      await refreshStatusSilent();
    } finally {
      setStatusRefreshing(false);
    }
  }, [refreshStatusSilent]);
  const obsStatusRows = useCallback(s => {
    if (!s?.obs_connected) return [];
    const currentEncoderLabel = formatObsEncoderLabel(s.recording?.encoder, t("obscfg.encoderUnknown"));
    const recommendedEncoder = s.recording?.recommended_encoder;
    const recommendedEncoderLabel = String(recommendedEncoder?.label || "").trim();
    const simpleHardwareCandidate = s.recording?.stream_encoder;
    const shouldRecommendHardware = obsEncoderIsConfigured(s.recording?.encoder) && !obsEncoderIsHardware(s.recording?.encoder) && !!recommendedEncoderLabel;
    const canApplyHardwareRecommendation = obsEncoderIsHardware(simpleHardwareCandidate);
    return [{
      label: t("obscfg.rowCanvas"),
      value: `${s.video?.base_width ?? 0}×${s.video?.base_height ?? 0}`,
      ok: s.video?.base_width === s.monitor?.width && s.video?.base_height === s.monitor?.height,
      issue: t("obscfg.resShouldBe", {
        w: s.monitor?.width ?? "?",
        h: s.monitor?.height ?? "?"
      })
    }, {
      label: t("obscfg.rowOutput"),
      value: `${s.video?.output_width ?? 0}×${s.video?.output_height ?? 0}`,
      ok: s.video?.output_width === s.monitor?.width && s.video?.output_height === s.monitor?.height,
      issue: t("obscfg.resShouldBe", {
        w: s.monitor?.width ?? "?",
        h: s.monitor?.height ?? "?"
      })
    }, {
      label: t("obscfg.rowScene"),
      value: s.scene?.dedicated_scene_exists ? t("obscfg.sceneExists") : t("obscfg.sceneNotExists"),
      ok: s.scene?.dedicated_scene_exists ?? false,
      issue: t("obscfg.sceneIssue")
    }, {
      label: t("obscfg.rowCapture"),
      value: !s.scene?.dedicated_scene_exists ? "—" : s.scene?.capture_source_exists ? t("obscfg.captureExists") : t("obscfg.captureNotExists"),
      ok: s.scene?.dedicated_scene_exists ? s.scene?.capture_source_exists ?? false : true,
      issue: t("obscfg.captureIssue"),
      skip: !s.scene?.dedicated_scene_exists
    }, {
      label: t("obscfg.rowStretch"),
      value: !s.scene?.capture_source_exists ? "—" : s.scene?.source_fit_to_canvas ? t("obscfg.stretchFit") : t("obscfg.stretchNotFit"),
      ok: s.scene?.capture_source_exists ? s.scene?.source_fit_to_canvas ?? false : true,
      issue: t("obscfg.stretchIssue"),
      skip: !s.scene?.capture_source_exists
    }, {
      label: t("obscfg.rowOutputMode"),
      value: s.recording?.output_mode === "Advanced" ? t("obscfg.outputModeAdvanced") : t("obscfg.outputModeSimple"),
      ok: s.recording?.output_mode === "Simple",
      issue: t("obscfg.outputModeIssue")
    }, {
      label: t("obscfg.rowEncoder"),
      value: currentEncoderLabel,
      ok: obsEncoderIsConfigured(s.recording?.encoder) && !shouldRecommendHardware,
      issue: shouldRecommendHardware ? t("obscfg.encoderRecommendationIssue", {
        current: currentEncoderLabel,
        recommended: recommendedEncoderLabel
      }) : t("obscfg.encoderIssue"),
      advisoryOnly: shouldRecommendHardware && !canApplyHardwareRecommendation
    }, {
      label: t("obscfg.rowFormat"),
      value: s.recording?.format === "hybrid_mp4" ? t("obscfg.formatHybridMp4") : s.recording?.format === "fragmented_mp4" ? t("obscfg.formatFragMp4") : s.recording?.format ?? t("obscfg.formatUnknown"),
      ok: s.recording?.format === "hybrid_mp4",
      issue: t("obscfg.formatIssue", {
        val: s.recording?.format === "hybrid_mp4" ? t("obscfg.formatHybridMp4") : s.recording?.format ?? t("obscfg.formatUnknown")
      })
    }, {
      label: t("obscfg.rowQuality"),
      value: s.recording?.output_mode === "Advanced" ? t("obscfg.qualityManagedByEncoder") : s.recording?.rec_quality === "Stream" ? t("obscfg.qualityStream") : s.recording?.rec_quality === "Small" ? t("obscfg.qualitySmall") : s.recording?.rec_quality === "HQ" ? t("obscfg.qualityHq") : s.recording?.rec_quality === "Lossless" ? t("obscfg.qualityLossless") : s.recording?.rec_quality ?? t("obscfg.qualityUnknown"),
      ok: s.recording?.output_mode === "Advanced" || s.recording?.rec_quality !== "Stream" && !!s.recording?.rec_quality,
      issue: t("obscfg.qualityIssue"),
      skip: s.recording?.output_mode === "Advanced"
    }, {
      label: t("obscfg.rowOutputDir"),
      value: s.recording?.output_path || t("obscfg.outputDirNotSet"),
      ok: true,
      infoOnly: true,
      outputPath: s.recording?.output_path || ""
    }];
  }, [t]);

  // Search hides rows and groups in the active tab that do not mention the query.
  const searchLower = search.trim().toLowerCase();
  const hidden = (...texts) => Boolean(searchLower) && !texts.some(text => String(text ?? "").toLowerCase().includes(searchLower));
  const activeTabDef = ALL_TABS.find(tab => tab.key === activeTab) ?? ALL_TABS[0];
  const renderNavItem = tab => {
    const Icon = tab.icon;
    const active = activeTab === tab.key;
    return <button key={tab.key} type="button" onClick={() => selectTab(tab.key)} aria-current={active ? "page" : undefined} className={`flex h-[34px] w-auto shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 md:w-full ${active ? "bg-cs2-accent-soft font-semibold text-cs2-accent" : "text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary"}`}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{t(tab.labelKey)}</span>
      </button>;
  };
  const recordingTab = activeTab === "recording";
  const showSaveBar = !SELF_SAVING_TABS.has(activeTab) && (recordingTab ? recordingSaveUi.changes > 0 || recordingSaveUi.state === "saving" || recordingSaveUi.state === "saved" || Boolean(recordingSaveUi.error) : pendingChanges > 0 || saving || savedFlash || Boolean(saveMsg));
  const saveBarChanges = recordingTab ? recordingSaveUi.changes : pendingChanges;
  const saveBarBusy = recordingTab ? recordingSaveUi.state === "saving" : saving;
  const saveBarSaved = recordingTab ? recordingSaveUi.state === "saved" : savedFlash && pendingChanges === 0;
  const saveBarError = recordingTab ? recordingSaveUi.error : saveMsg?.tone === "error" ? saveMsg.text : "";
  const nav = <nav aria-label={t("settings.navLabel")} className="flex shrink-0 flex-col border-b border-cs2-border-subtle md:w-56 md:border-b-0 md:border-r">
      <div className="px-3.5 pb-2.5 pt-4 md:pt-5">
        <h1 className="mb-3 ml-1 hidden text-base font-bold text-cs2-text-primary md:block">{t("settings.pageTitle")}</h1>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" aria-hidden />
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t("settings.searchPlaceholder")} aria-label={t("settings.searchPlaceholder")} className="h-8 w-full rounded-md border border-cs2-border-subtle bg-cs2-bg-card pl-8 pr-2.5 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted outline-none focus:border-cs2-accent" />
        </label>
      </div>
      <div className="flex min-h-0 gap-1 overflow-x-auto px-2.5 pb-3 md:block md:flex-1 md:overflow-y-auto md:overflow-x-hidden">
        {NAV_GROUPS.map(group => <div key={group.labelKey} className="contents md:block">
            <p className="hidden px-2.5 pb-1.5 pt-3.5 text-[11px] font-semibold tracking-wide text-cs2-text-muted md:block">
              {t(group.labelKey)}
            </p>
            {group.items.map(tab => <div key={tab.key} className="contents md:block">
                {renderNavItem(tab)}
                {tab.key === "recording" && recordingTab ? <RecordingSectionMenu sections={RECORDING_PRESET_SECTIONS} activeSection={activeSection} onSelect={jumpToSection} ariaLabel={t("settings.presetNavLabel")} className="my-1 ml-[17px] hidden md:flex" /> : null}
              </div>)}
          </div>)}
      </div>
    </nav>;
  if (loading || !config) {
    return <div className="flex min-h-0 w-full flex-1 bg-cs2-bg-page">
        <div className="flex flex-1 items-center justify-center">
          {loading ? <Loader2 className="h-6 w-6 animate-spin text-cs2-accent" /> : <p className="text-sm text-cs2-text-muted">{t("settings.loadConfigFailed")}</p>}
        </div>
      </div>;
  }
  const obs = config.obs ?? {};
  const llm = config.llm ?? {};
  const aiObsRecommendationEnabled = AI_OBS_RECOMMENDATION_ENABLED;
  const isLocalEndpoint = llm.base_url && (llm.base_url.includes("localhost") || llm.base_url.includes("127.0.0.1"));
  const obsRows = obsStatusRows(status);
  const obsHasIssues = obsRows.some(r => !r.skip && !r.infoOnly && !r.advisoryOnly && !r.ok);
  const obsIssueCount = obsRows.filter(r => !r.skip && !r.infoOnly && !r.ok).length;
  const pageHeader = activeTab === "recording" ? null : <SettingsPageHeader title={t(activeTabDef.labelKey)} description={activeTabDef.descKey ? t(activeTabDef.descKey) : null} />;
  return <div className="flex min-h-0 w-full flex-1 flex-col bg-cs2-bg-page md:flex-row">
      {nav}

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* relative: visually hidden radios/checkboxes must be positioned inside this
            scroller, or focusing them scrolls the app's overflow-hidden workspace. */}
        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto" style={{
        scrollbarGutter: "stable"
      }}>
          <div className={`mx-auto w-full px-4 pb-6 pt-5 sm:px-8 md:pt-7 lg:px-10 ${activeTab === "video" && aiObsRecommendationEnabled ? "max-w-[1180px]" : "max-w-[1040px]"}`}>
            {pageHeader}

            {/* ======================== General ======================== */}
            {activeTab === "general" && <>
                <SettingsGroup title={t("settings.groupInterface")} search={hidden(t("settings.groupInterface"), t("settings.labelLocale"), t("settings.localeZh"), t("settings.localeEn"), t("settings.labelBackground"), t("settings.showGuideOnStartup"))}>
                  <SettingsRow label={t("settings.labelLocale")} search={hidden(t("settings.groupInterface"), t("settings.labelLocale"), t("settings.localeZh"), t("settings.localeEn"))}>
                    <Segmented ariaLabel={t("settings.labelLocale")} value={config.locale ?? "auto"} onChange={v => {
                  const previousLocale = config.locale ?? "auto";
                  set("locale", v);
                  setSavedConfig(prev => prev ? {
                    ...prev,
                    locale: v
                  } : prev);
                  void useLocaleStore.getState().setLocale(v).catch(() => {
                    set("locale", previousLocale);
                    setSavedConfig(prev => prev ? {
                      ...prev,
                      locale: previousLocale
                    } : prev);
                    setSaveMsg({
                      text: t("settings.localePersistFailed"),
                      tone: "error"
                    });
                  });
                }} options={[{
                  value: "auto",
                  label: t("settings.localeAuto")
                }, {
                  value: "zh",
                  label: t("settings.localeZh")
                }, {
                  value: "en",
                  label: t("settings.localeEn")
                }]} />
                  </SettingsRow>
                  <SettingsRow label={t("settings.labelBackground")} description={t("settings.backgroundShort")} search={hidden(t("settings.groupInterface"), t("settings.labelBackground"))}>
                    <SelectInput ariaLabel={t("settings.labelBackground")} value={background} onChange={changeBackground} options={[{
                  value: "solid",
                  label: t("settings.backgroundSolid")
                }, {
                  value: "",
                  label: t("settings.backgroundRandom")
                }, ...backgrounds]} />
                  </SettingsRow>
                  {backgroundFailed ? <SettingsNote tone="rose" role="alert">{t("settings.backgroundSaveFailed")}</SettingsNote> : null}
                  <SettingsRow label={t("settings.showGuideOnStartup")} description={t("settings.showGuideOnStartupDesc")} search={hidden(t("settings.groupInterface"), t("settings.showGuideOnStartup"))}>
                    <Switch ariaLabel={t("settings.showGuideOnStartup")} checked={showGuideOnStartup} onChange={changeShowGuideOnStartup} />
                  </SettingsRow>
                  {startupGuideFailed ? <SettingsNote tone="rose" role="alert">{t("settings.interfaceSaveFailed")}</SettingsNote> : null}
                </SettingsGroup>

                <SettingsGroup title={t("settings.sectionNetworkAssets")} description={t("settings.sectionNetworkAssetsHint")} search={hidden(t("settings.sectionNetworkAssets"), t("settings.labelSteamCdnAssets"), "Steam CDN avatar cs2-lib")}>
                  <SettingsRow label={t("settings.labelSteamCdnAssets")} description={t("settings.steamCdnAssetsShort")} tooltip={t("settings.hintSteamCdnAssets")}>
                    <Switch checked={config.steam_cdn_assets_enabled !== false} onChange={value => set("steam_cdn_assets_enabled", value)} ariaLabel={t("settings.labelSteamCdnAssets")} />
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title={t("playercfg.pageTitle")} description={t("settings.playerConfigShort")} search={hidden(t("playercfg.pageTitle"), "player config", t("playercfg.btnOpenBackupDir"))} actions={<>
                      <SettingsButton variant="ghost" onClick={() => void shell.handleOpenConfigBackupDir()}>
                        {t("playercfg.btnOpenBackupDir")}
                      </SettingsButton>
                      <SettingsButton iconOnly icon={RefreshCw} aria-label={t("playercfg.btnRefresh")} title={t("playercfg.btnRefresh")} onClick={() => void shell.refreshConfigBackupStatus()} />
                    </>}>
                  {playerConfigLoading ? <SettingsRow label={<span className="inline-flex items-center gap-2 text-cs2-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin text-cs2-accent" aria-hidden />{t("playercfg.loading")}</span>} /> : playerConfigStatus?.fetch_failed ? <SettingsNote tone="rose" icon={XCircle}>
                      <p className="font-semibold">{t("playercfg.fetchFailTitle")}</p>
                      <p className="mt-1 opacity-90">{playerConfigStatus.message}</p>
                      <p className="mt-1 text-cs2-text-muted">
                        {t("playercfg.fetchFailHint", {
                    data: "data",
                    data2: "data",
                    backup: ".cs2_config_backup"
                  })}
                      </p>
                    </SettingsNote> : playerConfigStatus?.restore_required ? <SettingsNote tone="amber" icon={ShieldAlert}>
                      <p className="font-semibold">{t("playercfg.restoreTitle")}</p>
                      <p className="mt-1">{t("playercfg.restoreDesc")}</p>
                      {typeof playerConfigStatus.cs2_running === "boolean" && <p className="mt-1 font-mono">
                          {playerConfigStatus.cs2_running ? t("playercfg.cs2StatusRunning") : t("playercfg.cs2StatusStopped")}
                        </p>}
                      {playerConfigStatus.process_error && <p className="mt-1 text-cs2-rose-on-surface">{playerConfigStatus.process_error}</p>}
                      {playerConfigStatus.backup_dir && <p className="mt-1 break-all font-mono text-cs2-text-muted">
                          {t("playercfg.backupDir")}{playerConfigStatus.backup_dir}
                        </p>}
                      <SettingsButton variant="primary" className="mt-2.5" onClick={() => void shell.handleRestorePlayerConfig()}>
                        {t("playercfg.btnRestore")}
                      </SettingsButton>
                    </SettingsNote> : <SettingsRow label={<StatusText tone="ok">{t("playercfg.okTitle")}</StatusText>} description={playerConfigStatus?.backup_dir ? <span className="break-all font-mono">{playerConfigStatus.backup_dir}</span> : t("settings.playerConfigOkShort")} />}
                </SettingsGroup>
              </>}

            {/* ======================== Paths & storage ======================== */}
            {activeTab === "paths" && <>
                <SettingsGroup title={t("settings.groupGame")} search={hidden(t("settings.labelCs2Path"), config.cs2_path)}>
                  <SettingsRow label={t("settings.labelCs2Path")} description={t("settings.hintCs2Path")} stacked>
                    <PathPicker value={config.cs2_path ?? ""} onChange={v => set("cs2_path", v)} placeholder="cs2.exe" exeName="cs2.exe" detectApi="config/detect-cs2" detectField="cs2_path" ariaLabel={t("settings.labelCs2Path")} t={t} />
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title={t("settings.groupStorage")} search={hidden(t("settings.groupStorage"), t("settings.sectionDemoCache"), t("settings.labelLiteCutStorage"), t("settings.labelReplayCache"), t("settings.labelDataDirectory"), t("settings.labelLogDirectory"), "", demoCacheDraft, liteCutStorageDraft, "")}>
                  <SettingsRow label={t("settings.sectionDemoCache")} description={t("settings.demoCacheStats", {
                files: demoCacheInfo?.file_count ?? 0,
                size: formatFileSize(Number(demoCacheInfo?.total_bytes) || 0),
                cached: demoCacheInfo?.demo_cached ?? 0,
                total: demoCacheInfo?.demo_total ?? 0
              })} tooltip={t("settings.hintDemoCachePath")} aside={<SizeLabel>{formatFileSize(Number(demoCacheInfo?.total_bytes) || 0)}</SizeLabel>} search={hidden(t("settings.sectionDemoCache"), t("settings.labelDemoCachePath"), demoCacheDraft)} stacked>
                    <TextInput value={demoCacheDraft} onChange={v => {
                  setDemoCacheDraft(v);
                  setDemoCacheMsg(null);
                }} placeholder={demoCacheInfo?.default_path || ""} ariaLabel={t("settings.labelDemoCachePath")} mono className="flex-1 basis-60" />
                    <SettingsButton onClick={browseDemoCache} disabled={demoCacheBusy}>{t("settings.browseBtn")}</SettingsButton>
                    <SettingsButton onClick={migrateDemoCache} busy={demoCacheBusy} disabled={demoCacheBusy || !demoCacheDraft.trim()}>
                      {demoCacheBusy ? t("settings.demoCacheMigrating") : t("settings.migrateBtn")}
                    </SettingsButton>
                    <SettingsButton variant="danger" onClick={clearDemoCache} disabled={demoCacheBusy}>{t("settings.clearBtn")}</SettingsButton>
                    <MessageText message={demoCacheMsg} />
                  </SettingsRow>

                  <SettingsRow label={t("settings.labelLiteCutStorageShort")} description={t("settings.hintLiteCutStorageShort")} tooltip={t("settings.hintLiteCutStorage")} aside={<SizeLabel>{formatFileSize(Number(liteCutStorage?.size_bytes) || 0)}</SizeLabel>} search={hidden(t("settings.labelLiteCutStorage"), liteCutStorageDraft)} stacked>
                    <TextInput value={liteCutStorageDraft} onChange={v => {
                  setLiteCutStorageDraft(v);
                  setLiteCutStorageMsg(null);
                }} placeholder={"D:\\CS2 Insight\\LiteCut"} ariaLabel={t("settings.labelLiteCutStorage")} mono className="flex-1 basis-60" />
                    <SettingsButton onClick={browseLiteCutStorage} disabled={liteCutStorageBusy}>{t("settings.browseBtn")}</SettingsButton>
                    {/* A running migration turns the migrate button into its cancel button. */}
                    {liteCutStorageBusy && liteCutStorageJob?.job_id && liteCutStorageJob.status !== "cancelling" ? <SettingsButton variant="danger" onClick={cancelLiteCutStorageMigration}>
                        {t("settings.liteCutStorageCancel")}
                      </SettingsButton> : <SettingsButton onClick={migrateLiteCutStorage} busy={liteCutStorageBusy && Boolean(liteCutStorageJob)} disabled={liteCutStorageBusy || !liteCutStorageDraft.trim() || liteCutStorageDraft.trim() === liteCutStorage?.path}>
                        {liteCutStorageBusy && liteCutStorageJob ? t("settings.liteCutStorageMigrating") : t("settings.migrateBtn")}
                      </SettingsButton>}
                    <SettingsButton variant="danger" onClick={clearLiteCutStorage} disabled={liteCutStorageBusy}>{t("settings.clearBtn")}</SettingsButton>
                    {liteCutStorageBusy && liteCutStorageJob ? <div className="w-full rounded-md border border-cs2-border-subtle bg-cs2-bg-input p-2">
                        <div className="flex items-center justify-between text-[11px] text-cs2-text-muted">
                          <span>{t(`settings.liteCutStorageStage.${liteCutStorageJob.stage || "copying"}`)}</span>
                          <span>{Math.round((Number(liteCutStorageJob.progress) || 0) * 100)}% · {Number(liteCutStorageJob.copied_files) || 0}/{Number(liteCutStorageJob.total_files) || 0}</span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-cs2-bg-elevated">
                          <div className="h-full bg-cs2-accent transition-[width]" style={{
                      width: `${Math.round((Number(liteCutStorageJob.progress) || 0) * 100)}%`
                    }} />
                        </div>
                      </div> : null}
                    <MessageText message={liteCutStorageMsg} />
                  </SettingsRow>

                  {null}

                  <SettingsRow label={t("settings.labelReplayCache")} description={<>
                        <span className="break-all font-mono">{replayCacheInfo?.path ?? "—"}</span>
                        <span> · {t("settings.replayCacheFiles", {
                    count: Number(replayCacheInfo?.files) || 0
                  })}</span>
                      </>} tooltip={t("settings.hintReplayCache")} search={hidden(t("settings.labelReplayCache"), replayCacheInfo?.path)} aside={<SizeLabel>{formatFileSize(Number(replayCacheInfo?.bytes) || 0)}</SizeLabel>}>
                    <SettingsButton variant="danger" onClick={clearReplayCache} busy={replayCacheBusy} disabled={replayCacheBusy || !(Number(replayCacheInfo?.files) > 0)}>
                      {replayCacheBusy ? t("settings.replayCacheClearing") : t("settings.replayCacheClear")}
                    </SettingsButton>
                    <MessageText message={replayCacheMsg} />
                  </SettingsRow>

                  <SettingsRow label={t("settings.labelDataDirectory")} description={<span className="break-all font-mono">{dataDirInfo?.path ?? "—"}</span>} tooltip={t("settings.hintDataDirectory")} search={hidden(t("settings.labelDataDirectory"), dataDirInfo?.path)} aside={<SizeLabel>{dataDirInfo?.size_str ?? "—"}</SizeLabel>}>
                    <SettingsButton onClick={() => API.post("config/open-dir").catch(() => {})}>{t("settings.openDirBtn")}</SettingsButton>
                  </SettingsRow>

                  <SettingsRow label={t("settings.labelLogDirectory")} description={<span className="break-all font-mono">{dataDirInfo?.logs_path ?? "—"}</span>} tooltip={t("settings.hintLogDirectory")} search={hidden(t("settings.labelLogDirectory"), dataDirInfo?.logs_path)}>
                    <SettingsButton onClick={() => API.post("config/open-logs").catch(() => {})}>{t("settings.openLogsBtn")}</SettingsButton>
                  </SettingsRow>
                </SettingsGroup>
              </>}

            {/* ======================== OBS & FFmpeg ======================== */}
            {activeTab === "video" && <>
                <SettingsGroup title={t("settings.sectionPaths")} description={null} search={hidden(t("settings.sectionPaths"), t("settings.labelObsPath"), t("settings.labelFfmpegPath"), t("settings.labelMontageEncoder"))}>
                  {<SettingsRow label={t("settings.labelObsPath")} description={t("settings.hintObsPath")} search={hidden(t("settings.labelObsPath"), obs.obs_path)} stacked>
                      <PathPicker value={obs.obs_path ?? ""} onChange={v => set("obs.obs_path", v)} placeholder="obs64.exe" exeName="obs64.exe" detectApi="config/detect-obs" detectField="obs_path" ariaLabel={t("settings.labelObsPath")} t={t} />
                    </SettingsRow>}
                  <SettingsRow label={t("settings.labelFfmpegPath")} description={t("settings.hintFfmpegPath")} search={hidden(t("settings.labelFfmpegPath"), config.ffmpeg_path)} stacked>
                    <PathPicker value={config.ffmpeg_path ?? ""} onChange={v => set("ffmpeg_path", v)} placeholder="ffmpeg.exe" exeName="ffmpeg.exe" detectApi="config/detect-ffmpeg" detectField="ffmpeg_path" ariaLabel={t("settings.labelFfmpegPath")} t={t} />
                  </SettingsRow>
                  <SettingsRow label={t("settings.labelMontageEncoder")} description={t("settings.sectionEncoderHint")} search={hidden(t("settings.labelMontageEncoder"), t("settings.sectionEncoder"))}>
                    <SelectInput ariaLabel={t("settings.labelMontageEncoder")} value={config.montage_encoder ?? "auto"} onChange={v => set("montage_encoder", v)} options={ENCODER_OPTIONS.map(o => ({
                  value: o.value,
                  label: t(o.key)
                }))} />
                  </SettingsRow>
                </SettingsGroup>

                {<>
                    <SettingsGroup title={t("settings.sectionObs")} search={hidden(t("settings.sectionObs"), t("settings.labelObsHost"), t("settings.labelObsPort"), t("settings.labelObsPassword"))} actions={<>
                          {checkResult ? !checkResult.error && checkResult.path_ok && checkResult.connected ? <StatusText tone="ok">{t("obscfg.connOk")}</StatusText> : checkResult.error ? <span className="max-w-xs truncate text-xs text-cs2-rose-on-surface" title={checkResult.error}>{checkResult.error}</span> : <StatusText tone="warn">{!checkResult.path_ok ? t("obscfg.pathError") : t("obscfg.connFail")}</StatusText> : null}
                          <SettingsButton onClick={() => void handleConfigCheck()} busy={checking} disabled={checking}>
                            {checking ? t("obscfg.btnChecking") : t("obscfg.btnConfigCheck")}
                          </SettingsButton>
                        </>}>
                      <SettingsRow label={t("settings.labelObsHost")} description={t("settings.obsHostShort")} tooltip={t("settings.obsHostChangeHint")}>
                        <div className="w-56">
                          <ObsHostField value={obs.host ?? "localhost"} onChange={v => set("obs.host", v)} showHint={false} />
                        </div>
                      </SettingsRow>
                      <SettingsRow label={t("settings.labelObsPort")}>
                        <NumberInput value={obs.port ?? 4455} defaultValue={4455} onChange={v => set("obs.port", v)} min={1} max={65535} ariaLabel={t("settings.labelObsPort")} className="w-56" inputClassName="w-full text-left" />
                      </SettingsRow>
                      <SettingsRow label={t("settings.labelObsPassword")}>
                        <TextInput type="password" value={obs.password ?? ""} onChange={v => set("obs.password", v)} placeholder="OBS WebSocket password" ariaLabel={t("settings.labelObsPassword")} className="w-56" />
                      </SettingsRow>
                    </SettingsGroup>

                    <SettingsGroup title={t("obscfg.sectionCalibrate")} description={status?.obs_connected ? obsIssueCount > 0 ? t("settings.obsIssueCount", {
                n: obsIssueCount
              }) : t("obscfg.btnNoIssues") : t("settings.obsCalibrateShort")} search={hidden(t("obscfg.sectionCalibrate"), t("obscfg.rowCanvas"), t("obscfg.rowOutput"), t("obscfg.rowScene"))} actions={<>
                          <SettingsButton variant="ghost" icon={RefreshCw} onClick={() => void handleRefreshStatus()} disabled={statusRefreshing} busy={statusRefreshing}>
                            {t("obscfg.btnRefresh")}
                          </SettingsButton>
                          <SettingsButton variant="primary" onClick={() => void handleCalibrate()} busy={calibrating} disabled={calibrating || !status?.obs_connected || !obsHasIssues} title={!status?.obs_connected ? t("obscfg.btnTitleNotConnected") : !obsHasIssues ? t("obscfg.btnTitleAllOk") : ""}>
                            {t("obscfg.btnFix")}
                          </SettingsButton>
                        </>}>
                      {status?.obs_connected ? obsRows.map(item => <div key={item.label} className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-xs">
                            <span className="text-cs2-text-muted">{item.label}</span>
                            <span className="truncate font-mono text-[11.5px] text-cs2-text-secondary" title={item.value}>{item.value}</span>
                            {item.skip ? <span className="text-cs2-text-muted">—</span> : item.infoOnly ? item.outputPath ? <SettingsButton variant="ghost" icon={FolderOpen} title={t("obscfg.btnOpenFolderTitle")} onClick={() => API.post("/open-folder", {
                    path: item.outputPath
                  }).catch(() => {})}>
                                  {t("obscfg.btnOpenFolder")}
                                </SettingsButton> : <span className="text-cs2-text-muted">—</span> : item.ok ? <StatusText tone="ok">{t("obscfg.statusOk")}</StatusText> : <span className="flex max-w-[16rem] items-start gap-1 text-right text-cs2-amber-on-surface">
                                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />{item.issue}
                              </span>}
                          </div>) : <SettingsRow label={<StatusText tone="error">{t("obscfg.connFail")}</StatusText>} description={t("settings.obsConnectFirst")} />}
                      {calibrateResult?.changed?.length > 0 ? <SettingsNote tone="emerald" icon={CheckCircle2}>
                          {calibrateResult.changed.map((msg, i) => <p key={i}>{msg}</p>)}
                        </SettingsNote> : null}
                      {calibrateResult?.error ? <SettingsNote tone="rose" icon={XCircle}>{calibrateResult.error}</SettingsNote> : null}
                    </SettingsGroup>
                  </>}
              </>}

            {/* ======================== Parse & AI ======================== */}
            {activeTab === "parse" && <>
                <SettingsGroup title={t("settings.sectionAnalysisMode")} search={hidden(t("settings.sectionAnalysisMode"), t("settings.modeAi"), t("settings.modeLocal"), t("settings.sectionLlm"))}>
                  <SettingsRow label={t("settings.labelAnalysisMode")} description={config.ai_mode ? t("settings.modeAiDesc") : t("settings.modeLocalDesc")}>
                    <Segmented ariaLabel={t("settings.sectionAnalysisMode")} value={Boolean(config.ai_mode)} onChange={v => set("ai_mode", v)} options={[{
                  value: false,
                  label: t("settings.modeLocal")
                }, {
                  value: true,
                  label: t("settings.modeAi")
                }]} />
                  </SettingsRow>
                  {config.ai_mode && isLocalEndpoint ? <SettingsNote tone="neutral" icon={Info}>{t("settings.localEndpointHint")}</SettingsNote> : null}
                  {config.ai_mode ? <>
                      <SettingsRow label={t("settings.labelLlmBaseUrl")} indent>
                        <TextInput value={llm.base_url ?? ""} onChange={v => set("llm.base_url", v || null)} placeholder={t("settings.baseUrlPlaceholder")} ariaLabel={t("settings.labelLlmBaseUrl")} mono className="w-80 max-w-full" />
                      </SettingsRow>
                      <SettingsRow label={t("settings.labelLlmModel")} indent>
                        <TextInput value={llm.model ?? ""} onChange={v => set("llm.model", v)} placeholder={t("settings.modelPlaceholder")} ariaLabel={t("settings.labelLlmModel")} mono className="w-80 max-w-full" />
                      </SettingsRow>
                      <SettingsRow label={t("settings.labelLlmApiKey")} description={llm.api_key ? t("settings.apiKeySavedShort") : null} indent>
                        <TextInput type="password" value={llm.api_key ?? ""} onChange={v => set("llm.api_key", v)} placeholder={t("settings.apiKeyPlaceholderKeep")} ariaLabel={t("settings.labelLlmApiKey")} mono className="w-80 max-w-full" />
                      </SettingsRow>
                    </> : null}
                </SettingsGroup>

                <SettingsGroup title={t("settings.sectionPlayers")} description={t("settings.sectionPlayersHint")} search={hidden(t("settings.sectionPlayers"), "players", ...(config.expected_parse_players ?? []))}>
                  <SettingsRow stacked>
                    <TagList items={config.expected_parse_players ?? []} onChange={v => set("expected_parse_players", v)} placeholder={t("settings.playerInputPlaceholder")} addLabel={t("settings.playerAddBtn")} emptyLabel={t("settings.playersEmpty")} removeLabel={name => t("settings.removeItem", {
                  name
                })} />
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title={t("settings.sectionWatchPaths")} description={t("settings.sectionWatchPathsHint")} search={hidden(t("settings.sectionWatchPaths"), ...(config.demo_watch_paths ?? []))}>
                  <SettingsRow stacked>
                    <TagList items={config.demo_watch_paths ?? []} onChange={v => set("demo_watch_paths", v)} placeholder={"C:\\demos\\auto-watch"} addLabel={t("settings.sidebarWatchAdd")} emptyLabel={t("settings.watchPathsEmpty")} removeLabel={name => t("settings.removeItem", {
                  name
                })} mono />
                  </SettingsRow>
                </SettingsGroup>
              </>}

            {/* ======================== Game resources ======================== */}
            {activeTab === "game-resources" && <div className="mt-7">
                <GameResourcesSettings search={search} />
              </div>}

            {/* ======================== Subtitle cache ======================== */}


            {/* ======================== Recording presets ======================== */}
            {activeTab === "recording" && <RecordingParamsPage embedded onRegisterSave={registerRecordingSave} onRegisterDiscard={registerRecordingDiscard} onSaveUiChange={updateRecordingSaveUi} />}

            {/* ======================== About ======================== */}
            {activeTab === "about" && <>
                <SettingsGroup title={t("settings.groupVersion")} search={hidden(t("settings.currentVersion"), "version", t("settings.checkUpdateBtn"))}>
                  <SettingsRow label={<>
                        {t("settings.currentVersion")}
                        <span className="font-mono text-cs2-text-secondary">{appVersion}</span>
                      </>} description={[t("settings.hintAutoUpdateOnStartup"), config.last_update_check_at ? `${t("settings.lastCheckTime")}: ${formatLastCheckTime(config.last_update_check_at, t, effectiveLocale)}` : ""].filter(Boolean).join(" · ")}>
                    <SettingsButton icon={Download} onClick={() => void shell.fetchUpdateInfo({
                  manual: true
                })}>
                      {t("settings.checkUpdateBtn")}
                    </SettingsButton>
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup title={t("settings.groupFeedback")} search={hidden(t("settings.groupFeedback"), "github issue bug ciacut.cc", t("settings.aboutOfficialWebsite"), t("settings.btnSponsor"))}>
                  <SettingsRow label={t("settings.aboutOfficialWebsite")} description="ciacut.cc">
                    <SettingsButton variant="ghost" icon={ExternalLink} onClick={() => openExternalLink("https://ciacut.cc")}>
                      {t("settings.aboutOpen")}
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={t("settings.aboutGithub")} description={t("settings.aboutGithubShort")}>
                    <SettingsButton variant="ghost" icon={ExternalLink} onClick={() => openExternalLink("https://github.com/DrEAmSs59/CS2-insight-agent")}>
                      GitHub
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={t("settings.btnViewIssues")} description={t("settings.aboutIssuesShort")}>
                    <SettingsButton variant="ghost" icon={ExternalLink} onClick={() => openExternalLink("https://github.com/DrEAmSs59/CS2-insight-agent/issues")}>
                      {t("settings.aboutOpen")}
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={t("settings.btnReportBug")} description={t("settings.aboutBugShort")}>
                    <SettingsButton variant="ghost" icon={ExternalLink} onClick={() => openIssueTemplate("bug")}>
                      {t("settings.aboutOpen")}
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={t("settings.btnRequestFeature")}>
                    <SettingsButton variant="ghost" icon={ExternalLink} onClick={() => openIssueTemplate("feature")}>
                      {t("settings.aboutOpen")}
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={t("settings.btnContact")} description="dreamss29_@outlook.com">
                    <SettingsButton variant="ghost" icon={ExternalLink} onClick={() => openExternalLink(`mailto:dreamss29_@outlook.com?subject=${encodeURIComponent(t("settings.contactEmailSubject"))}`)}>
                      {t("settings.aboutOpen")}
                    </SettingsButton>
                  </SettingsRow>
                  <SettingsRow label={t("settings.btnSponsor")} stacked>
                    <div className="grid w-full grid-cols-2 items-start gap-6">
                      {[{
                    file: "wx.jpg",
                    labelKey: "settings.sponsorWx",
                    width: 1152,
                    height: 1152
                  }, {
                    file: "ali.jpg",
                    labelKey: "settings.sponsorAli",
                    width: 1170,
                    height: 1393
                  }].map(({
                    file,
                    labelKey,
                    width,
                    height
                  }) => <figure key={file} className="min-w-0 text-center">
                          <img src={`${import.meta.env.BASE_URL}asset/${file}`} alt={t(labelKey)} width={width} height={height} loading="lazy" className="mx-auto block h-auto w-full max-w-sm rounded-lg border border-cs2-border" />
                          <figcaption className="mt-2 text-xs text-cs2-text-muted">{t(labelKey)}</figcaption>
                        </figure>)}
                    </div>
                  </SettingsRow>
                </SettingsGroup>
              </>}

            {showSaveBar ? <div data-testid="settings-save-footer-card" role="status" className="sticky bottom-4 z-10 mt-7 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-cs2-border bg-cs2-bg-elevated py-2 pl-4 pr-2 shadow-lg">
                <p className="flex min-w-0 items-center gap-2 text-[13px]">
                  {saveBarError ? <>
                      <XCircle className="h-4 w-4 shrink-0 text-cs2-rose-on-surface" aria-hidden />
                      <span className="truncate text-cs2-rose-on-surface" title={saveBarError}>{saveBarError}</span>
                    </> : saveBarSaved ? <>
                      <Check className="h-4 w-4 shrink-0 text-cs2-emerald-on-surface" aria-hidden />
                      <span className="text-cs2-emerald-on-surface">{t("settings.savedNotice")}</span>
                    </> : <>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cs2-accent" aria-hidden />
                      <span className="text-cs2-text-primary">{t("settings.unsavedCount", {
                    n: saveBarChanges
                  })}</span>
                    </>}
                </p>
                {saveBarChanges > 0 || saveBarBusy ? <div className="flex items-center gap-1.5">
                    <SettingsButton variant="ghost" icon={RotateCcw} disabled={saveBarBusy} onClick={() => recordingTab ? recordingDiscardRef.current?.() : handleDiscard()}>
                      {t("settings.discardChanges")}
                    </SettingsButton>
                    <SettingsButton variant="primary" busy={saveBarBusy} disabled={recordingTab ? recordingSaveUi.disabled : saving} onClick={() => recordingTab ? recordingSaveRef.current?.() : void handleSave()}>
                      {saveBarBusy ? t("settings.savingBtn") : t("settings.saveChanges")}
                    </SettingsButton>
                  </div> : null}
              </div> : null}
          </div>
        </div>
      </main>

      {!restartAlertDismissed && (calibrateResult?.restart_obs_required || checkResult?.restart_obs_required) && <div role="alert" aria-live="assertive" data-testid="obs-restart-required-alert" className="fixed right-5 top-14 z-[100] w-[34rem] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-xl border-2 border-amber-400 bg-[#2b1d0d] shadow-[0_20px_70px_rgba(0,0,0,0.7),0_0_36px_rgba(251,191,36,0.38)]">
          <div className="flex items-start gap-3 border-b border-amber-300/30 bg-gradient-to-r from-amber-500/25 via-amber-400/10 to-orange-500/20 px-4 py-3.5">
            <div className="flex h-10 w-10 shrink-0 animate-pulse items-center justify-center rounded-full bg-amber-300 text-zinc-950 shadow-[0_0_22px_rgba(252,211,77,0.65)]">
              <AlertTriangle className="h-5 w-5" strokeWidth={2.8} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-amber-300 px-1.5 py-0.5 text-[9px] font-black tracking-wider text-zinc-950">
                  {t("obscfg.restartRequiredBadge")}
                </span>
                <h4 className="text-[15px] font-black text-amber-100">
                  {t("obscfg.restartRequiredTitle")}
                </h4>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-amber-100/85">
                {t("obscfg.restartRequired")}
              </p>
            </div>
            <button type="button" onClick={() => setRestartAlertDismissed(true)} aria-label={t("common.close")} title={t("common.close")} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-amber-200/25 text-amber-100/75 transition-colors hover:border-amber-200/50 hover:bg-amber-100/10 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="bg-black/15 px-4 py-3">
            <div className="flex items-center gap-2 rounded-lg border border-amber-300/25 bg-black/25 px-3 py-2 text-[11px] font-bold text-amber-100">
              <RotateCcw className="h-4 w-4 shrink-0 text-amber-300" />
              <span>{t("obscfg.restartRequiredSteps")}</span>
            </div>
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-400/45 bg-red-500/20 px-3 py-2 text-[11px] font-bold text-red-100">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("obscfg.restartRequiredDanger")}</span>
            </div>
          </div>
        </div>}
    </div>;
}
