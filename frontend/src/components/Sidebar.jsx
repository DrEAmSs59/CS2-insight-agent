import { useState, useEffect } from "react";
import API from "../api/api";
import { useT } from "../i18n/useT.js";
import {
  Settings,
  Brain,
  Zap,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Monitor,
  Server,
  FolderOpen,
  ScanSearch,
  Users,
  RefreshCw,
} from "lucide-react";

function llmBaseUrlLooksLocal(baseUrl) {
  try {
    const u = String(baseUrl || "").trim();
    if (!u) return false;
    const withProto = u.includes("://") ? u : `http://${u}`;
    const host = new URL(withProto).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export default function Sidebar({
  aiMode,
  onAiModeChange,
  obsConfig,
  onObsConfigChange,
  onPersistObs,
  obsPasswordPlaceholder = "",
  onObsPasswordFocus,
  onObsPasswordBlur,
  llmConfig,
  onLlmConfigChange,
  llmKeySavedOnServer = false,
  onPersistLlm,
  cs2Path,
  onCs2PathChange,
  ffmpegPath = "",
  onFfmpegPathChange,
  montageEncoder = "auto",
  onMontageEncoderChange,
  demoWatchPaths = [],
  onDemoWatchPathsChange,
  onSaveConfig,
  onDetectCs2,
  onScanDemos,
  demoLibraryLoading = false,
  expectedParsePlayersText = "",
  onExpectedParsePlayersTextChange,
  onSaveExpectedParsePlayers,
}) {
  const t = useT();
  const [obsOpen, setObsOpen] = useState(true);
  const [cs2Open, setCs2Open] = useState(true);
  const [llmOpen, setLlmOpen] = useState(true);
  const [expectedPlayersOpen, setExpectedPlayersOpen] = useState(true);
  const [detectingCs2, setDetectingCs2] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [watchOpen, setWatchOpen] = useState(true);
  const [watchPathInput, setWatchPathInput] = useState("");
  const [systemOpen, setSystemOpen] = useState(true);
  const [updateStatus, setUpdateStatus] = useState(null);
  const [isPackaged, setIsPackaged] = useState(false);

  useEffect(() => {
    if (window.electron?.isPackaged) {
      window.electron.isPackaged().then(setIsPackaged);
    }

    if (window.electron?.onUpdateStatus) {
      window.electron.onUpdateStatus((status) => {
        setUpdateStatus(status);
        if (status.status === "not-available" || status.status === "error") {
          setTimeout(() => setUpdateStatus(null), 5000);
        }
      });
    }
  }, []);

  const handleCheckUpdates = () => {
    if (!isPackaged) {
      setUpdateStatus({ status: "error", message: t("settings.updateDevModeError") });
      setTimeout(() => setUpdateStatus(null), 3000);
      return;
    }
    if (window.electron?.checkForUpdates) {
      setUpdateStatus({ status: "checking", message: t("settings.updateChecking") });
      window.electron.checkForUpdates();
    }
  };

  const handleDetectCs2 = async () => {
    if (!onDetectCs2) return;
    setDetectingCs2(true);
    try {
      await onDetectCs2();
    } finally {
      setDetectingCs2(false);
    }
  };

  const schedulePersistLlm = () => {
    if (!onPersistLlm) return;
    queueMicrotask(() => {
      void onPersistLlm();
    });
  };

  const isLocal = llmBaseUrlLooksLocal(llmConfig.base_url);

  return (
    <aside className="w-60 bg-cs2-bg-sidebar border-r border-cs2-border flex flex-col overflow-y-auto shrink-0">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-cs2-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-cs2-accent/20 flex items-center justify-center">
            <Monitor className="w-4 h-4 text-cs2-accent" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-wide">{t("settings.sidebarBrand")}</div>
            <div className="text-[10px] text-cs2-text-secondary font-mono tracking-widest">{t("settings.sidebarVersionLabel")} v1.1.2</div>
          </div>
        </div>
      </div>

      {/* Mode Switcher */}
      <div className="px-4 py-4 border-b border-cs2-border">
        <div className="text-[10px] font-semibold text-cs2-text-secondary tracking-widest uppercase mb-3">
          {t("settings.sidebarAnalysisMode")}
        </div>
        <div className="grid grid-cols-2 gap-1 bg-cs2-bg-page rounded-lg p-1">
          <button
            type="button"
            onClick={() => void onAiModeChange(false)}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-semibold transition-all ${
              !aiMode
                ? "bg-cs2-accent text-cs2-text-on-accent shadow-lg shadow-cs2-accent/20"
                : "text-cs2-text-secondary hover:text-cs2-text-primary"
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            {t("settings.modeLocal")}
          </button>
          <button
            type="button"
            onClick={() => void onAiModeChange(true)}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-semibold transition-all ${
              aiMode
                ? "bg-cs2-accent text-cs2-text-on-accent shadow-lg shadow-cs2-accent/20"
                : "text-cs2-text-secondary hover:text-cs2-text-primary"
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            {t("settings.modeAi")}
          </button>
        </div>
      </div>

      {/* System & Updates (shown in production and dev for debugging) */}
      <div className="border-b border-cs2-border">
        <button
          type="button"
          onClick={() => setSystemOpen(!systemOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <RefreshCw className="h-3.5 w-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">
              {t("settings.cardSystem")} {!isPackaged && <span className="text-[9px] text-cs2-orange ml-1">(DEV)</span>}
            </span>
          </div>
          {systemOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {systemOpen && (
          <div className="px-4 pb-4 space-y-3">
            {updateStatus && (
              <div
                className={`text-[10px] px-3 py-2 rounded border font-mono ${
                  updateStatus.status === "error"
                    ? "bg-cs2-fail/10 border-cs2-fail/20 text-cs2-fail"
                    : updateStatus.status === "available"
                    ? "bg-cs2-orange/10 border-cs2-orange/20 text-cs2-orange"
                    : "bg-cs2-highlight/10 border-cs2-highlight/20 text-cs2-highlight"
                }`}
              >
                <div className="flex justify-between items-center mb-1">
                  <span>{updateStatus.message}</span>
                  {updateStatus.status === "downloading" && (
                    <span>{Math.round(updateStatus.progress?.percent || 0)}%</span>
                  )}
                </div>
                {updateStatus.status === "downloading" && (
                  <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-cs2-highlight transition-all duration-300"
                      style={{ width: `${updateStatus.progress?.percent || 0}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={handleCheckUpdates}
              disabled={
                updateStatus?.status === "checking" || updateStatus?.status === "downloading"
              }
              className="flex w-full items-center justify-center gap-2 py-2 rounded-md text-[11px] font-semibold bg-cs2-bg-input border border-cs2-border hover:border-cs2-orange/50 transition-colors disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  updateStatus?.status === "checking" || updateStatus?.status === "downloading"
                    ? "animate-spin"
                    : ""
                }`}
              />
              {t("settings.btnCheckUpdatesLong")}
            </button>
          </div>
        )}
      </div>

      {/* OBS Config */}
      <div className="border-b border-cs2-border">
        <button
          onClick={() => setObsOpen(!obsOpen)}
          className="flex items-center justify-between w-full px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <Settings className="w-3.5 h-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold tracking-wide uppercase text-cs2-text-secondary">
              {t("settings.sidebarObsSection")}
            </span>
          </div>
          {obsOpen ? (
            <ChevronUp className="w-3.5 h-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {obsOpen && (
          <div className="px-4 pb-4 space-y-3">
            <Input label={t("settings.sidebarObsHost")} value={obsConfig.host} onChange={(v) => onObsConfigChange({ ...obsConfig, host: v })} />
            <Input label={t("settings.sidebarObsPort")} value={obsConfig.port || ""} type="number" onChange={(v) => onObsConfigChange({ ...obsConfig, port: Number(v) })} />
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
                {t("settings.sidebarObsPassword")}
              </label>
              <input
                type="password"
                value={obsConfig.password}
                placeholder={obsPasswordPlaceholder}
                onChange={(e) => onObsConfigChange({ ...obsConfig, password: e.target.value })}
                onFocus={() => onObsPasswordFocus?.()}
                onBlur={() => onObsPasswordBlur?.()}
                autoComplete="new-password"
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-accent/50 focus:outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {/* CS2 path — required for one-click recording */}
      <div className="border-b border-cs2-border">
        <button
          type="button"
          onClick={() => setCs2Open(!cs2Open)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">
              {t("settings.cardCs2Path")}
            </span>
          </div>
          {cs2Open ? (
            <ChevronUp className="h-3.5 w-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {cs2Open && (
          <div className="space-y-2 px-4 pb-4">
            <Input
              label={t("settings.fieldCs2Exe")}
              value={cs2Path ?? ""}
              placeholder="...\\game\\bin\\win64\\cs2.exe"
              onChange={(v) => onCs2PathChange?.(v)}
              onBlur={() => onSaveConfig?.({ cs2_path: cs2Path ?? "" })}
            />
            <Input
              label={t("settings.fieldFfmpegSidebarLabel")}
              value={ffmpegPath ?? ""}
              placeholder={t("settings.ffmpegPathPlaceholder")}
              onChange={(v) => onFfmpegPathChange?.(v)}
              onBlur={() => onSaveConfig?.({ ffmpeg_path: ffmpegPath ?? "" })}
            />
            <div className="space-y-1">
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-cs2-text-secondary">
                {t("settings.encoderLabel")}
              </label>
              <select
                value={montageEncoder ?? "auto"}
                onChange={(e) => onMontageEncoderChange?.(e.target.value)}
                onBlur={() => onSaveConfig?.({ montage_encoder: montageEncoder ?? "auto" })}
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary transition-colors focus:border-cs2-accent/50 focus:outline-none"
              >
                <option value="auto">{t("settings.encoderAutoSidebar")}</option>
                <option value="h264_nvenc">NVIDIA NVENC</option>
                <option value="h264_qsv">Intel Quick Sync (QSV)</option>
                <option value="h264_amf">AMD AMF</option>
                <option value="libx264">{t("settings.encoderX264")}</option>
              </select>
            </div>
            <button
              type="button"
              onClick={handleDetectCs2}
              disabled={detectingCs2}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-accent/50 disabled:opacity-50"
            >
              <ScanSearch className="h-3.5 w-3.5" />
              {detectingCs2 ? t("settings.detectingLabel") : t("settings.autoDetectCs2")}
            </button>
            <p className="text-[10px] leading-relaxed text-cs2-text-secondary">
              {t("settings.sidebarCs2PathHint")}
            </p>
          </div>
        )}
      </div>

      <div className="border-b border-cs2-border">
        <button
          type="button"
          onClick={() => setWatchOpen(!watchOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <FolderOpen className="h-3.5 w-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">
              {t("settings.sidebarWatchPaths")}
            </span>
          </div>
          {watchOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {watchOpen && (
          <div className="space-y-2 px-4 pb-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={watchPathInput}
                onChange={(e) => setWatchPathInput(e.target.value)}
                placeholder="D:\\SteamLibrary\\...\\csgo"
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-accent/50 focus:outline-none"
              />
              <button
                type="button"
                className="rounded-md border border-cs2-border bg-cs2-bg-input px-3 text-xs font-semibold hover:border-cs2-accent/50"
                onClick={() => {
                  const p = watchPathInput.trim();
                  if (!p) return;
                  const next = Array.from(new Set([...(demoWatchPaths || []), p]));
                  onDemoWatchPathsChange?.(next);
                  onSaveConfig?.({ demo_watch_paths: next });
                  setWatchPathInput("");
                }}
              >
                {t("settings.sidebarWatchAdd")}
              </button>
            </div>
            <div className="space-y-1">
              {(demoWatchPaths || []).map((p) => (
                <div
                  key={p}
                  className="flex items-center justify-between rounded border border-cs2-border bg-cs2-bg-input/60 px-2 py-1"
                >
                  <span className="truncate font-mono text-[10px] text-cs2-text-secondary">{p}</span>
                  <button
                    type="button"
                    className="text-[10px] text-cs2-fail hover:opacity-80"
                    onClick={() => {
                      const next = (demoWatchPaths || []).filter((x) => x !== p);
                      onDemoWatchPathsChange?.(next);
                      onSaveConfig?.({ demo_watch_paths: next });
                    }}
                  >
                    {t("settings.sidebarWatchRemove")}
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              disabled={demoLibraryLoading}
              onClick={() => void onScanDemos?.()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-accent/50 disabled:opacity-50"
            >
              <ScanSearch className={`h-3.5 w-3.5 ${demoLibraryLoading ? "animate-spin" : ""}`} />
              {t("settings.sidebarScanDemos")}
            </button>
          </div>
        )}
      </div>

      <div className="border-b border-cs2-border">
        <button
          type="button"
          onClick={() => setExpectedPlayersOpen(!expectedPlayersOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-cs2-text-secondary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-cs2-text-secondary">
              {t("settings.cardPlayers")}
            </span>
          </div>
          {expectedPlayersOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-cs2-text-secondary" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-cs2-text-secondary" />
          )}
        </button>
        {expectedPlayersOpen && (
          <div className="space-y-2 px-4 pb-4">
            <p className="text-[10px] leading-relaxed text-cs2-text-secondary">
              {t("settings.sidebarPlayersHint")}
            </p>
            <textarea
              rows={5}
              value={expectedParsePlayersText}
              onChange={(e) => onExpectedParsePlayersTextChange?.(e.target.value)}
              placeholder={"PlayerOne\nPlayerTwo"}
              className="w-full resize-y rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-[11px] text-cs2-text-primary placeholder:text-cs2-text-secondary/50 focus:border-cs2-accent/50 focus:outline-none"
              spellCheck={false}
            />
            <button
              type="button"
              className="w-full rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-accent/50"
              onClick={() => void onSaveExpectedParsePlayers?.()}
            >
              {t("settings.sidebarSavePlayerList")}
            </button>
          </div>
        )}
      </div>

      {/* LLM Config (AI mode only) */}
      {aiMode && (
        <div className="border-b border-cs2-border">
          <button
            onClick={() => setLlmOpen(!llmOpen)}
            className="flex items-center justify-between w-full px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              <Brain className="w-3.5 h-3.5 text-cs2-text-secondary" />
              <span className="text-xs font-semibold tracking-wide uppercase text-cs2-text-secondary">
                {t("settings.cardLlmSidebarTitle")}
              </span>
            </div>
            {llmOpen ? (
              <ChevronUp className="w-3.5 h-3.5 text-cs2-text-secondary" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-cs2-text-secondary" />
            )}
          </button>
          {llmOpen && (
            <div className="px-4 pb-4 space-y-3">
              <Input
                label={t("settings.fieldBaseUrl")}
                value={llmConfig.base_url || ""}
                placeholder={t("settings.baseUrlPlaceholder")}
                onChange={(v) => onLlmConfigChange({ ...llmConfig, base_url: v })}
                onBlur={schedulePersistLlm}
              />

              <Input
                label={t("settings.fieldModel")}
                value={llmConfig.model}
                placeholder={t("settings.modelPlaceholderSidebar")}
                onChange={(v) => onLlmConfigChange({ ...llmConfig, model: v })}
                onBlur={schedulePersistLlm}
              />

              {isLocal && (
                <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-md bg-cs2-accent/10 border border-cs2-accent/20">
                  <Server className="w-3 h-3 text-cs2-accent shrink-0" />
                  <span className="text-[10px] text-cs2-accent">
                    {t("settings.localEndpointInfoSidebar")}
                  </span>
                </div>
              )}

              {!isLocal && (
                <div>
                  <label className="block text-[10px] font-semibold text-cs2-text-secondary tracking-wider uppercase mb-1.5">
                    {t("settings.fieldApiKey")}
                  </label>
                  {llmKeySavedOnServer && !llmConfig.api_key?.trim() && (
                    <p className="mb-1.5 text-[10px] leading-relaxed text-cs2-emerald-on-surface/90">
                      {t("settings.apiKeySavedSidebar")}
                    </p>
                  )}
                  <div className="relative">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={llmConfig.api_key}
                      placeholder={
                        llmKeySavedOnServer && !llmConfig.api_key?.trim()
                          ? t("settings.apiKeyPlaceholderKeep")
                          : "sk-..."
                      }
                      onChange={(e) => onLlmConfigChange({ ...llmConfig, api_key: e.target.value })}
                      onBlur={schedulePersistLlm}
                      className="w-full bg-cs2-bg-input border border-cs2-border rounded-md px-3 py-2 pr-9 text-xs text-cs2-text-primary placeholder-cs2-text-secondary/50 focus:outline-none focus:border-cs2-accent/50 transition-colors font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cs2-text-secondary hover:text-cs2-text-primary transition-colors"
                    >
                      {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-auto px-4 py-4 border-t border-cs2-border">
        <div className="text-[10px] text-cs2-text-secondary font-mono text-center">
          {t("settings.sidebarFooter")}
        </div>
      </div>
    </aside>
  );
}

function Input({ label, value, type = "text", placeholder, onChange, onBlur }) {
  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">
        {label}
      </label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-accent/50 focus:outline-none"
      />
    </div>
  );
}
