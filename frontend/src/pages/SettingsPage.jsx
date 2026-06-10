import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import API from "../api/api";
import { useAppShell } from "../context/AppShellContext";
import { useT } from "../i18n/useT.js";
import {
  Brain,
  Zap,
  Eye,
  EyeOff,
  Check,
  Server,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  ScanSearch,
} from "lucide-react";

function FfmpegDetectButton({ onDetect }) {
  const t = useT();
  const [detecting, setDetecting] = useState(false);

  const handleClick = async () => {
    if (!onDetect) return;
    setDetecting(true);
    try {
      await onDetect();
    } finally {
      setDetecting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={detecting}
      className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-accent/50 disabled:opacity-50"
    >
      {detecting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <ScanSearch className="h-3.5 w-3.5" />
      )}
      {detecting ? t("settings.detectingLabel") : t("settings.autoDetectFfmpeg")}
    </button>
  );
}

function EncoderSelector({ value, onChange }) {
  const t = useT();
  const [detecting, setDetecting] = useState(false);
  const [result, setResult] = useState(null);
  const abortRef = useRef(null);

  const CODEC_LABELS = {
    h264_nvenc: "NVIDIA NVENC",
    h264_qsv: "Intel QSV",
    h264_amf: "AMD AMF",
    libx264: t("settings.encoderX264Label"),
    none: t("settings.encoderNone"),
  };

  const detect = async () => {
    setDetecting(true);
    setResult(null);
    try {
      const r = await API.post("/config/detect-encoder");
      setResult(r.data);
    } catch (e) {
      setResult({ error: e?.response?.data?.detail || e?.message || t("settings.encoderProbeFailed") });
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="shrink-0 space-y-2">
      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-cs2-text-secondary">
        {t("settings.encoderLabel")}
      </label>
      <div className="flex gap-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-dynamic-white focus:border-cs2-orange/50 focus:outline-none"
        >
          <option value="auto">{t("settings.encoderAuto")}</option>
          <option value="h264_nvenc">NVIDIA NVENC</option>
          <option value="h264_qsv">Intel Quick Sync (QSV)</option>
          <option value="h264_amf">AMD AMF</option>
          <option value="libx264">{t("settings.encoderX264")}</option>
        </select>
        <button
          type="button"
          onClick={detect}
          disabled={detecting}
          className="flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-surface-1 px-3 py-1.5 text-xs font-medium text-cs2-text-secondary hover:border-cs2-border-focus hover:text-cs2-text-primary disabled:opacity-40 transition-all"
        >
          {detecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          {t("settings.detectBtn")}
        </button>
      </div>

      {result && !result.error && (
        <div className="rounded-lg border border-cs2-border-subtle bg-cs2-surface-1 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-cs2-text-primary">
            <span className="text-cs2-text-muted">{t("settings.encoderAutoSelected")}</span>
            <span className={result.selected === "libx264" || result.selected === "none" ? "text-amber-400" : "text-emerald-400"}>
              {CODEC_LABELS[result.selected] ?? result.selected}
            </span>
          </div>
          <div className="space-y-1">
            {result.hw?.map((h) => (
              <div key={h.codec} className="flex items-start gap-2 text-[11px]">
                {h.probe_ok
                  ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cs2-text-muted" />}
                <span className={h.probe_ok ? "text-cs2-text-primary" : "text-cs2-text-muted"}>
                  <span className="font-mono">{h.codec}</span>
                  {!h.in_encoder_list && <span className="ml-1 text-amber-400/80">{t("settings.encoderNotCompiled")}</span>}
                  {h.in_encoder_list && !h.probe_ok && <span className="ml-1 text-cs2-text-muted">{t("settings.encoderProbeFailed")}</span>}
                  {h.error && !h.probe_ok && (
                    <span className="ml-1 block text-[10px] text-cs2-text-muted/70 leading-snug">{h.error}</span>
                  )}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-2 text-[11px]">
              {result.libx264_available
                ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-cs2-text-muted" />
                : <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />}
              <span className={result.libx264_available ? "font-mono text-cs2-text-muted" : "font-mono text-red-400"}>
                libx264
              </span>
            </div>
          </div>
          {!result.hw?.some(h => h.probe_ok) && (
            <p className="text-[11px] text-amber-400/90 leading-snug">
              {t("settings.encoderNoHwWarning")}
            </p>
          )}
        </div>
      )}
      {result?.error && (
        <p className="text-[11px] text-red-400">{result.error}</p>
      )}
      {!result && <p className="text-[10px] text-zinc-600">{t("settings.encoderClickHint")}</p>}
    </div>
  );
}

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

function parsePlayerLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @param {"ok"|"warn"|"err"|"muted"} tone */
function StatusLine({ tone, children }) {
  const dot =
    tone === "ok"
      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.45)]"
      : tone === "warn"
        ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.35)]"
        : tone === "err"
          ? "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.35)]"
          : "bg-zinc-500";
  return (
    <div className="flex items-start gap-2 text-[11px] leading-snug text-dynamic-zinc-300">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function SettingsCard({ title, hint, children, className = "", fill = false }) {
  return (
    <section
      className={`rounded-xl border border-white/[0.08] bg-cs2-bg-card/90 p-3 shadow-sm shadow-black/20 sm:p-4 ${
        fill
          ? "flex min-h-0 w-full min-w-0 flex-col @min-[68rem]/settings:flex-1"
          : "flex w-full min-w-0 flex-col"
      } ${className}`}
    >
      <div className="mb-3 shrink-0">
        <h2 className="text-[13px] font-bold tracking-wide text-dynamic-zinc-100">{title}</h2>
        {hint ? <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{hint}</p> : null}
      </div>
      {fill ? (
        <div className="flex min-h-0 w-full min-w-0 flex-col @min-[68rem]/settings:flex-1">{children}</div>
      ) : (
        children
      )}
    </section>
  );
}

function SecondaryButton({ children, className = "", ...rest }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[11px] font-semibold text-dynamic-zinc-200 transition-colors hover:border-cs2-orange/45 hover:text-dynamic-white disabled:opacity-45 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function PrimaryButton({ children, className = "", ...rest }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md bg-cs2-orange px-4 py-2.5 text-xs font-bold text-black shadow-md shadow-cs2-orange/25 transition-colors hover:bg-cs2-orange/90 disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function PathFieldRow({ label, value, placeholder, onChange, onBlurSave, onPastePath, pasteTitle }) {
  const t = useT();
  return (
    <div className="w-full max-w-full space-y-1.5">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">{label}</label>
      <div className="flex w-full max-w-full flex-wrap items-end gap-2">
        <input
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlurSave}
          className="min-w-[min(100%,10rem)] shrink grow basis-48 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2.5 font-mono text-[11px] text-dynamic-white transition-colors placeholder:text-cs2-text-secondary/50 focus:border-cs2-orange/50 focus:outline-none"
        />
        <SecondaryButton
          type="button"
          className="shrink-0 px-2.5 py-2"
          onClick={onPastePath}
          title={pasteTitle ?? t("settings.pastePathTitle")}
        >
          {t("settings.pastePathBtn")}
        </SecondaryButton>
      </div>
    </div>
  );
}

function SmallField({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">{label}</label>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const t = useT();
  const s = useAppShell();
  const [setup, setSetup] = useState(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [players, setPlayers] = useState(() => parsePlayerLines(s.expectedParsePlayersText));
  const [playerDraft, setPlayerDraft] = useState("");

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

  useEffect(() => {
    setPlayers(parsePlayerLines(s.expectedParsePlayersText));
  }, [s.expectedParsePlayersText]);

  const refreshSetup = useCallback(async () => {
    try {
      const { data } = await API.get("status/setup");
      setSetup(data);
    } catch {
      setSetup(null);
    }
  }, []);

  useEffect(() => {
    void refreshSetup();
    const id = window.setInterval(() => void refreshSetup(), 10000);
    return () => window.clearInterval(id);
  }, [refreshSetup]);

  const isLocal = llmBaseUrlLooksLocal(s.llmConfig.base_url);

  const schedulePersistLlm = () => {
    queueMicrotask(() => void s.persistLlmConfig());
  };

  const cs2Status = useMemo(() => {
    if (!setup) return { tone: "muted", text: t("settings.statusCs2Detecting") };
    if (setup.cs2_path_ok) return { tone: "ok", text: t("settings.statusCs2Ok") };
    if (String(s.cs2Path || "").trim())
      return { tone: "warn", text: t("settings.statusCs2PathBad") };
    return { tone: "err", text: t("settings.statusCs2Missing") };
  }, [setup, s.cs2Path, t]);

  const ffmpegStatus = useMemo(() => {
    if (!setup) return { tone: "muted", text: t("settings.statusFfmpegDetecting") };
    if (setup.ffmpeg_ok) return { tone: "ok", text: t("settings.statusFfmpegOk") };
    return { tone: "warn", text: t("settings.statusFfmpegMissing") };
  }, [setup, t]);

  const aiRowStatus = useMemo(() => {
    if (!s.aiMode) return { tone: "muted", text: t("settings.statusAiLocal") };
    if (isLocal) {
      return { tone: "ok", text: t("settings.statusAiLocalEndpoint") };
    }
    if (!setup) return { tone: "muted", text: t("settings.statusAiDetecting") };
    if (setup.ai_key_ok || s.llmKeySavedOnServer) {
      return { tone: "ok", text: t("settings.statusAiOk") };
    }
    return { tone: "warn", text: t("settings.statusAiKeyMissing") };
  }, [s.aiMode, s.llmKeySavedOnServer, setup, isLocal, t]);

  const handlePasteCs2 = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) {
        s.setCs2Path(text);
        await s.handleSaveConfig({ cs2_path: text });
      }
    } catch {
      s.setProgressText(t("settings.clipboardError"));
    }
  };

  const handlePasteFfmpeg = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) {
        s.setFfmpegPath(text);
        await s.handleSaveConfig({ ffmpeg_path: text });
      }
    } catch {
      s.setProgressText(t("settings.clipboardError"));
    }
  };

  const addPlayer = (name) => {
    const n = String(name || "").trim();
    if (!n) return;
    if (players.includes(n)) {
      setPlayerDraft("");
      return;
    }
    if (players.length >= 50) return;
    setPlayers((p) => [...p, n]);
    setPlayerDraft("");
  };

  const removePlayer = (name) => {
    setPlayers((p) => p.filter((x) => x !== name));
  };

  const editPlayer = (name) => {
    const next = window.prompt(t("settings.playerEditPrompt"), name);
    if (next == null) return;
    const trimmed = String(next).trim();
    if (!trimmed || trimmed === name) return;
    setPlayers((p) => p.map((x) => (x === name ? trimmed : x)));
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-cs2-bg-dark">
      <header className="shrink-0 border-b border-white/10 bg-cs2-bg-dark/95 px-4 py-3 backdrop-blur-sm sm:px-5">
        <div className="w-full min-w-0">
          <h1 className="text-lg font-bold tracking-tight text-dynamic-white">{t("settings.pageTitle")}</h1>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-zinc-500">
            {t("settings.pageSubtitle")}
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 min-[420px]:grid-cols-3 min-[420px]:gap-x-3">
            <StatusLine tone={cs2Status.tone}>{cs2Status.text}</StatusLine>
            <StatusLine tone={ffmpegStatus.tone}>{ffmpegStatus.text}</StatusLine>
            <StatusLine
              tone={
                aiRowStatus.tone === "err"
                  ? "err"
                  : aiRowStatus.tone === "warn"
                    ? "warn"
                    : aiRowStatus.tone === "ok"
                      ? "ok"
                      : "muted"
              }
            >
              {aiRowStatus.text}
            </StatusLine>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain">
          <div className="@container/settings flex min-h-0 w-full min-w-0 flex-1 flex-col px-3 py-3 sm:px-5 sm:py-4">
            <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 pb-5 @min-[68rem]/settings:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @min-[68rem]/settings:items-stretch @min-[68rem]/settings:gap-5 @min-[68rem]/settings:pb-6">
              <div className="flex min-w-0 flex-col gap-3 @min-[68rem]/settings:min-h-0 @min-[68rem]/settings:flex-1 @min-[68rem]/settings:gap-4">
            <SettingsCard
              title={t("settings.cardRunMode")}
              hint={t("settings.cardRunModeHint")}
            >
              <div className="flex w-full max-w-full flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void s.handleAiModeChange(false)}
                  className={`relative flex min-h-[5rem] shrink grow basis-40 flex-col rounded-lg border p-3 text-left transition-all ${
                    !s.aiMode
                      ? "border-cs2-orange bg-cs2-orange/12 shadow-[0_0_0_1px_rgba(255,140,0,0.35)]"
                      : "border-white/[0.08] bg-black/20 hover:border-white/15"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Zap className={`h-4 w-4 shrink-0 ${!s.aiMode ? "text-cs2-orange" : "text-zinc-500"}`} />
                    <span className={`text-sm font-bold ${!s.aiMode ? "text-dynamic-white" : "text-dynamic-zinc-400"}`}>{t("settings.modeLocal")}</span>
                    {!s.aiMode ? (
                      <Check className="ml-auto h-4 w-4 shrink-0 text-cs2-orange" aria-label={t("settings.modeSelectedAriaLabel")} />
                    ) : null}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">{t("settings.modeLocalDesc")}</p>
                </button>
                <button
                  type="button"
                  onClick={() => void s.handleAiModeChange(true)}
                  className={`relative flex min-h-[5rem] shrink grow basis-40 flex-col rounded-lg border p-3 text-left transition-all ${
                    s.aiMode
                      ? "border-cs2-orange bg-cs2-orange/12 shadow-[0_0_0_1px_rgba(255,140,0,0.35)]"
                      : "border-white/[0.08] bg-black/20 hover:border-white/15"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Brain className={`h-4 w-4 shrink-0 ${s.aiMode ? "text-cs2-orange" : "text-zinc-500"}`} />
                    <span className={`text-sm font-bold ${s.aiMode ? "text-dynamic-white" : "text-dynamic-zinc-400"}`}>{t("settings.modeAi")}</span>
                    {s.aiMode ? (
                      <Check className="ml-auto h-4 w-4 shrink-0 text-cs2-orange" aria-label={t("settings.modeSelectedAriaLabel")} />
                    ) : null}
                  </div>
                  <ul className="mt-2 space-y-0.5 text-[11px] leading-relaxed text-zinc-500">
                    <li>· {t("settings.modeAiDesc")}</li>
                  </ul>
                </button>
              </div>
            </SettingsCard>

            <SettingsCard
              title={t("settings.cardCs2Path")}
              hint={t("settings.cardCs2PathHint")}
            >
              <PathFieldRow
                label={t("settings.fieldCs2Exe")}
                value={s.cs2Path}
                placeholder="...\\game\\bin\\win64\\cs2.exe"
                onChange={s.setCs2Path}
                onBlurSave={() => void s.handleSaveConfig({ cs2_path: s.cs2Path ?? "" })}
                onPastePath={() => void handlePasteCs2()}
              />
            </SettingsCard>

            <SettingsCard
              title={t("settings.cardPlayers")}
              hint={t("settings.cardPlayersHint")}
            >
              <div className="flex flex-col gap-3">
                <div className="flex max-h-48 min-h-[5rem] w-full flex-wrap content-start gap-2 overflow-y-auto rounded-lg border border-white/[0.06] bg-black/25 p-2">
                {players.length === 0 ? (
                  <span className="flex min-h-[3rem] w-full items-center justify-center px-2 py-2 text-center text-[11px] text-dynamic-zinc-400">
                    {t("settings.playersEmpty")}
                  </span>
                ) : (
                  players.map((p) => (
                    <span
                      key={p}
                      className="group inline-flex items-center gap-1 rounded-md border border-cs2-orange/30 bg-cs2-orange/10 pl-2 pr-1 py-1 text-[11px] font-semibold text-cs2-orange"
                    >
                      <button
                        type="button"
                        className="max-w-[140px] truncate text-left hover:underline"
                        title={t("settings.playerEditTitle")}
                        onDoubleClick={() => editPlayer(p)}
                      >
                        {p}
                      </button>
                      <button
                        type="button"
                        className="rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-dynamic-white"
                        aria-label={t("settings.playerRemoveAriaLabel", { name: p })}
                        onClick={() => removePlayer(p)}
                      >
                        ✕
                      </button>
                    </span>
                  ))
                )}
                </div>
              <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <input
                  value={playerDraft}
                  onChange={(e) => setPlayerDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPlayer(playerDraft);
                    }
                  }}
                  placeholder={t("settings.playerInputPlaceholder")}
                  className="min-w-0 w-full flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[12px] text-dynamic-white placeholder:text-zinc-600 focus:border-cs2-orange/50 focus:outline-none"
                  spellCheck={false}
                />
                <SecondaryButton type="button" className="w-full shrink-0 sm:w-auto" onClick={() => addPlayer(playerDraft)}>
                  {t("settings.playerAddBtn")}
                </SecondaryButton>
              </div>
              </div>
            </SettingsCard>

            <SettingsCard title={t("settings.cardSystem")} hint={t("settings.cardSystemHint")}>
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg bg-black/20 p-3 border border-white/5">
                  <div>
                    <p className="text-[11px] font-semibold text-dynamic-zinc-300">{t("settings.currentVersion")}</p>
                    <p className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">v{__APP_VERSION__} {!isPackaged && "(DEV)"}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleCheckUpdates}
                    disabled={updateStatus?.status === "checking" || updateStatus?.status === "downloading"}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md text-[11px] font-bold transition-all border ${
                      updateStatus?.status === 'available'
                        ? 'bg-cs2-orange border-cs2-orange text-black'
                        : 'bg-cs2-bg-input border-cs2-border text-dynamic-white hover:border-cs2-orange/50'
                    } disabled:opacity-50`}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${updateStatus?.status === "checking" || updateStatus?.status === "downloading" ? "animate-spin" : ""}`} />
                    {updateStatus?.status === 'available' ? t("settings.btnUpdate") : t("settings.btnCheckUpdates")}
                  </button>
                </div>

                {updateStatus && (
                  <div className={`text-[10px] px-3 py-2 rounded border font-mono ${
                    updateStatus.status === 'error' ? 'bg-cs2-fail/10 border-cs2-fail/20 text-cs2-fail' :
                    updateStatus.status === 'available' ? 'bg-cs2-orange/10 border-cs2-orange/20 text-cs2-orange' :
                    'bg-cs2-highlight/10 border-cs2-highlight/20 text-cs2-highlight'
                  }`}>
                    <div className="flex justify-between items-center mb-1">
                      <span>{updateStatus.message}</span>
                      {updateStatus.status === 'downloading' && (
                        <span>{Math.round(updateStatus.progress?.percent || 0)}%</span>
                      )}
                    </div>
                    {updateStatus.status === 'downloading' && (
                      <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-cs2-highlight transition-all duration-300"
                          style={{ width: `${updateStatus.progress?.percent || 0}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* <div className="border-t border-white/5 pt-3 space-y-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-cs2-text-secondary">
                    GitHub 镜像（开发/手动下载）
                  </p>
                  <select
                    value={s.updateGithubMirror ?? "auto"}
                    onChange={(e) => s.setUpdateGithubMirror(e.target.value)}
                    onBlur={() => {
                      const v =
                        s.updateGithubMirror === "custom"
                          ? (s.updateGithubMirrorCustom || "").trim()
                          : (s.updateGithubMirror || "auto").trim();
                      void s.handleSaveConfig({ update_github_mirror: v || "auto" });
                    }}
                    className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary focus:border-cs2-accent/50 focus:outline-none"
                  >
                    <option value="auto">自动（镜像与直连并发，推荐）</option>
                    <option value="on">仅镜像</option>
                    <option value="off">仅 GitHub 直连</option>
                    <option value="custom">自定义镜像前缀</option>
                  </select>
                  {s.updateGithubMirror === "custom" ? (
                    <input
                      value={s.updateGithubMirrorCustom ?? ""}
                      placeholder="https://ghfast.top"
                      onChange={(e) => s.setUpdateGithubMirrorCustom(e.target.value)}
                      onBlur={() => {
                        const v = (s.updateGithubMirrorCustom || "").trim();
                        if (v) void s.handleSaveConfig({ update_github_mirror: v });
                      }}
                      className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-[12px] text-cs2-text-primary focus:border-cs2-accent/50 focus:outline-none"
                    />
                  ) : (
                    <p className="text-[10px] text-zinc-500">
                      内置 ghfast.top、mirror.ghproxy.com；安装包自动更新走 Electron，手动检查/开发模式走后端 API。
                    </p>
                  )}
                </div> */}
              </div>
            </SettingsCard>

              </div>

              {/* right column */}
              <div className="flex min-w-0 flex-col gap-3 @min-[68rem]/settings:min-h-0 @min-[68rem]/settings:flex-1 @min-[68rem]/settings:gap-4">
            <SettingsCard title={t("settings.cardFfmpeg")} hint={t("settings.cardFfmpegHint")} fill>
              <div className="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto">
                <div className="shrink-0 space-y-2">
                  <PathFieldRow
                    label={t("settings.fieldFfmpegExe")}
                    value={s.ffmpegPath}
                    placeholder={t("settings.ffmpegPathPlaceholder")}
                    onChange={s.setFfmpegPath}
                    onBlurSave={() => void s.handleSaveConfig({ ffmpeg_path: s.ffmpegPath ?? "" })}
                    onPastePath={() => void handlePasteFfmpeg()}
                  />
                  <FfmpegDetectButton onDetect={s.handleDetectFfmpeg} />
                  {setup && !setup.ffmpeg_ok && !String(s.ffmpegPath || "").trim() && (
                    <p className="text-[11px] leading-relaxed text-amber-400/90">
                      {t("settings.ffmpegMissingWarning")}
                    </p>
                  )}
                </div>
                <EncoderSelector
                  value={s.montageEncoder ?? "auto"}
                  onChange={(v) => { s.setMontageEncoder(v); void s.handleSaveConfig({ montage_encoder: v }); }}
                />
                <div className="flex-1" aria-hidden />
              </div>
            </SettingsCard>

            {s.aiMode ? (
              <SettingsCard
                title={t("settings.cardLlm")}
                hint={t("settings.cardLlmHint")}
                fill
              >
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  <SmallField label={t("settings.fieldBaseUrl")}>
                    <input
                      value={s.llmConfig.base_url || ""}
                      placeholder={t("settings.baseUrlPlaceholder")}
                      onChange={(e) => s.setLlmConfig({ ...s.llmConfig, base_url: e.target.value })}
                      onBlur={schedulePersistLlm}
                      className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2.5 font-mono text-[12px] text-dynamic-white focus:border-cs2-orange/50 focus:outline-none"
                    />
                  </SmallField>
                  <SmallField label={t("settings.fieldModel")}>
                    <input
                      value={s.llmConfig.model}
                      placeholder={t("settings.modelPlaceholder")}
                      onChange={(e) => s.setLlmConfig({ ...s.llmConfig, model: e.target.value })}
                      onBlur={schedulePersistLlm}
                      className="w-full min-w-0 max-w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-dynamic-white focus:border-cs2-orange/50 focus:outline-none @min-[40rem]/settings:max-w-md"
                    />
                  </SmallField>
                  {isLocal && (
                    <div className="flex items-center gap-1.5 rounded-md border border-cs2-orange/20 bg-cs2-orange/10 px-2.5 py-2">
                      <Server className="h-3 w-3 shrink-0 text-cs2-orange" />
                      <span className="text-[10px] text-cs2-orange">
                        {t("settings.localEndpointInfo")}
                      </span>
                    </div>
                  )}
                  {!isLocal && (
                    <div>
                      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-cs2-text-secondary">{t("settings.fieldApiKey")}</label>
                      {s.llmKeySavedOnServer && !s.llmConfig.api_key?.trim() && (
                        <p className="mb-1.5 text-[10px] leading-relaxed text-emerald-500/90">
                          {t("settings.apiKeySaved")}
                        </p>
                      )}
                      <div className="relative min-w-0 w-full max-w-full @min-[40rem]/settings:max-w-xl">
                        <input
                          type={showApiKey ? "text" : "password"}
                          value={s.llmConfig.api_key}
                          placeholder={s.llmKeySavedOnServer && !s.llmConfig.api_key?.trim() ? t("settings.apiKeyPlaceholderKeep") : "sk-..."}
                          onChange={(e) => s.setLlmConfig({ ...s.llmConfig, api_key: e.target.value })}
                          onBlur={schedulePersistLlm}
                          className="w-full rounded-md border border-cs2-border bg-cs2-bg-input py-2.5 pl-3 pr-10 font-mono text-[12px] text-dynamic-white focus:border-cs2-orange/50 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cs2-text-secondary hover:text-dynamic-white"
                        >
                          {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </SettingsCard>
            ) : null}

            <div className="flex shrink-0 flex-col items-stretch gap-3 rounded-xl border border-cs2-orange/25 bg-cs2-orange/[0.06] p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <p className="text-[11px] leading-relaxed text-dynamic-zinc-400">
                {t("settings.saveFooterDesc")}
              </p>
              <PrimaryButton
                className="shrink-0 sm:min-w-[140px]"
                onClick={() => void s.handleSaveAllSettingsPage(players)}
              >
                {t("settings.saveBtn")}
              </PrimaryButton>
            </div>

              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
