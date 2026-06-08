import { useCallback, useEffect, useRef, useState } from "react";
import API from "../api/api";
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, RefreshCw, RotateCcw, ScanSearch, Wifi, WifiOff } from "lucide-react";
import PageContainer from "../components/PageContainer";
import { useAppShell } from "../context/AppShellContext";
import { calibrateObs, getObsConfigStatus } from "../api/obsConfigCenter";
import { obsConfigHasIssues } from "../utils/obsConfigHealth";
import { useT } from "../i18n/useT.js";

export default function ObsConfigCenterPage() {
  const t = useT();
  const {
    obsConfig,
    setObsConfig,
    persistObsConfig,
    obsPasswordPlaceholder,
    handleObsPasswordFocus,
    handleObsPasswordBlur,
    batchRecording,
    setProgressText,
  } = useAppShell();

  const [status, setStatus] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrateResult, setCalibrateResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  const [errorText, setErrorText] = useState("");
  const [detectingObs, setDetectingObs] = useState(false);
  const [statusRefreshing, setStatusRefreshing] = useState(false);

  const obsConfigRef = useRef(obsConfig);
  obsConfigRef.current = obsConfig;

  const detectObsPath = async () => {
    setDetectingObs(true);
    try {
      const { data } = await API.post("/config/detect-obs");
      if (data?.obs_path) {
        setObsConfig({ ...obsConfigRef.current, obs_path: data.obs_path });
        await persistObsConfig?.();
      }
    } catch (e) {
      setErrorText(e.response?.data?.detail || e.message || t("obscfg.errorDetectFail"));
    } finally {
      setDetectingObs(false);
    }
  };

  const fetchStatus = useCallback(async () => {
    const st = await getObsConfigStatus();
    setStatus(st);
  }, []);

  const refreshSilent = useCallback(async () => {
    setErrorText("");
    try {
      await fetchStatus();
    } catch (e) {
      setErrorText(e.response?.data?.detail || e.message || t("obscfg.errorLoadFail"));
    }
  }, [fetchStatus, t]);

  const handleConfigCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    setErrorText("");
    try {
      const { data } = await API.post("/obs/config-check", obsConfigRef.current);
      setCheckResult(data);
      if (data.connected) {
        await persistObsConfig?.();
        await fetchStatus();
      }
    } catch (e) {
      setErrorText(e.response?.data?.detail || e.message || t("obscfg.errorCheckFail"));
    } finally {
      setChecking(false);
    }
  };

  // 进入页面时自动触发一次配置检查
  useEffect(() => {
    void handleConfigCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCalibrate = async () => {
    setCalibrating(true);
    setCalibrateResult(null);
    setErrorText("");
    try {
      const data = await calibrateObs();
      setCalibrateResult(data);
      const n = data.changed?.length ?? 0;
      setProgressText(
        n > 0 ? t("obscfg.calibratedN", { n }) : t("obscfg.calibratedOk"),
        { autoDismissMs: 8000 },
      );
      await refreshSilent();
    } catch (e) {
      setErrorText(e.response?.data?.detail || e.message || t("obscfg.errorCalibrateFail"));
    } finally {
      setCalibrating(false);
    }
  };

  const FORMAT_LABELS = {
    hybrid_mp4: t("obscfg.formatHybridMp4"),
    mp4: "MP4",
    mkv: "MKV",
    mov: "MOV",
    ts: "TS",
    fragmented_mp4: t("obscfg.formatFragMp4"),
  };
  const QUALITY_LABELS = {
    Stream: t("obscfg.qualityStream"),
    Small: t("obscfg.qualitySmall"),
    HQ: t("obscfg.qualityHq"),
    Lossless: t("obscfg.qualityLossless"),
  };

  const hasIssues = obsConfigHasIssues(status);

  const statusRows = status?.obs_connected
    ? [
        {
          label: t("obscfg.rowCanvas"),
          value: `${status.video?.base_width ?? 0}×${status.video?.base_height ?? 0}`,
          ok: status.video?.base_width === status.monitor?.width && status.video?.base_height === status.monitor?.height,
          issue: t("obscfg.resShouldBe", { w: status.monitor?.width ?? "?", h: status.monitor?.height ?? "?" }),
        },
        {
          label: t("obscfg.rowOutput"),
          value: `${status.video?.output_width ?? 0}×${status.video?.output_height ?? 0}`,
          ok: status.video?.output_width === status.monitor?.width && status.video?.output_height === status.monitor?.height,
          issue: t("obscfg.resShouldBe", { w: status.monitor?.width ?? "?", h: status.monitor?.height ?? "?" }),
        },
        {
          label: t("obscfg.rowScene"),
          value: status.scene?.dedicated_scene_exists ? t("obscfg.sceneExists") : t("obscfg.sceneNotExists"),
          ok: status.scene?.dedicated_scene_exists ?? false,
          issue: t("obscfg.sceneIssue"),
        },
        {
          label: t("obscfg.rowCapture"),
          value: !status.scene?.dedicated_scene_exists
            ? "—"
            : status.scene?.capture_source_exists
              ? t("obscfg.captureExists")
              : t("obscfg.captureNotExists"),
          ok: status.scene?.dedicated_scene_exists ? (status.scene?.capture_source_exists ?? false) : true,
          issue: t("obscfg.captureIssue"),
          skip: !status.scene?.dedicated_scene_exists,
        },
        {
          label: t("obscfg.rowStretch"),
          value: !status.scene?.capture_source_exists
            ? "—"
            : status.scene?.source_fit_to_canvas
              ? t("obscfg.stretchFit")
              : t("obscfg.stretchNotFit"),
          ok: status.scene?.capture_source_exists ? (status.scene?.source_fit_to_canvas ?? false) : true,
          issue: t("obscfg.stretchIssue"),
          skip: !status.scene?.capture_source_exists,
        },
        {
          label: t("obscfg.rowFormat"),
          value: FORMAT_LABELS[status.recording?.format] ?? status.recording?.format ?? t("obscfg.formatUnknown"),
          ok: status.recording?.format === "hybrid_mp4",
          issue: t("obscfg.formatIssue", { val: FORMAT_LABELS[status.recording?.format] ?? status.recording?.format ?? t("obscfg.formatUnknown") }),
        },
        {
          label: t("obscfg.rowQuality"),
          value: QUALITY_LABELS[status.recording?.rec_quality] ?? status.recording?.rec_quality ?? t("obscfg.qualityUnknown"),
          ok: status.recording?.rec_quality !== "Stream" && !!status.recording?.rec_quality,
          issue: t("obscfg.qualityIssue"),
        },
        {
          label: t("obscfg.rowOutputDir"),
          value: status.recording?.output_path || t("obscfg.outputDirNotSet"),
          ok: true,
          infoOnly: true,
          outputPath: status.recording?.output_path || "",
        },
      ]
    : [];

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto">
      <PageContainer>
        <div>
          <h1 className="text-lg font-bold tracking-wide text-cs2-text-primary">{t("obscfg.pageTitle")}</h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-cs2-text-secondary">
            {t("obscfg.pageSubtitle")}
          </p>
        </div>

        {errorText ? (
          <div className="mt-3 rounded-lg border border-cs2-border-error/40 bg-cs2-rose-surface px-3 py-2 text-[12px] text-cs2-rose-on-surface">
            {errorText}
          </div>
        ) : null}

        {/* OBS 程序设置 */}
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-cs2-text-primary">{t("obscfg.sectionSettings")}</h2>
            <button
              type="button"
              onClick={() => void handleConfigCheck()}
              disabled={checking}
              title={t("obscfg.btnConfigCheck")}
              className="shrink-0 flex items-center gap-1.5 rounded-lg border border-cs2-border bg-cs2-bg-input px-4 py-2 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:bg-cs2-bg-hover disabled:opacity-50"
            >
              {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {checking ? t("obscfg.btnChecking") : t("obscfg.btnConfigCheck")}
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-cs2-text-secondary">
            {t("obscfg.settingsDesc")}
          </p>

          {/* 启动配置 */}
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold text-cs2-text-primary">{t("obscfg.launchConfig")}</div>
              {checkResult != null && (
                checkResult.path_ok ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-text-success">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    {t("obscfg.pathOk")}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-amber-on-surface">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {t("obscfg.pathError")}
                  </span>
                )
              )}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-secondary">
              {t("obscfg.launchDesc")}
            </p>
            <div className="mt-2 space-y-2">
              <input
                type="text"
                value={obsConfig.obs_path ?? ""}
                onChange={(e) => setObsConfig({ ...obsConfig, obs_path: e.target.value })}
                placeholder={t("obscfg.obsPathPlaceholder")}
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors placeholder:text-cs2-text-muted/80 focus:border-cs2-accent/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void detectObsPath()}
                disabled={detectingObs}
                title={t("obscfg.btnDetectTitle")}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-accent/50 disabled:opacity-50"
              >
                {detectingObs ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ScanSearch className="h-3.5 w-3.5" />
                )}
                {detectingObs ? t("obscfg.btnDetecting") : t("obscfg.btnDetectObs")}
              </button>
            </div>
          </div>

          {/* 连接配置 */}
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold text-cs2-text-primary">{t("obscfg.connConfig")}</div>
              {checkResult != null ? (
                checkResult.connected ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-text-success">
                    <Wifi className="h-3.5 w-3.5 shrink-0" />
                    {t("obscfg.connOk")}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-amber-on-surface">
                    <WifiOff className="h-3.5 w-3.5 shrink-0" />
                    {t("obscfg.connFail")}
                  </span>
                )
              ) : null}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-secondary">
              {t("obscfg.connDesc")}
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  {t("obscfg.fieldHost")}
                </label>
                <input
                  type="text"
                  value={obsConfig.host ?? ""}
                  onChange={(e) => setObsConfig({ ...obsConfig, host: e.target.value })}
                  className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors focus:border-cs2-accent/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  {t("obscfg.fieldPort")}
                </label>
                <input
                  type="number"
                  value={obsConfig.port || ""}
                  onChange={(e) => setObsConfig({ ...obsConfig, port: Number(e.target.value) })}
                  className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors focus:border-cs2-accent/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  {t("obscfg.fieldPassword")}
                </label>
                <input
                  type="password"
                  value={obsConfig.password ?? ""}
                  placeholder={obsPasswordPlaceholder}
                  onChange={(e) => setObsConfig({ ...obsConfig, password: e.target.value })}
                  onFocus={() => handleObsPasswordFocus?.()}
                  onBlur={() => handleObsPasswordBlur?.()}
                  autoComplete="new-password"
                  className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors placeholder:text-cs2-text-muted/80 focus:border-cs2-accent/50 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {checkResult?.error && !checkResult.path_ok && !checkResult.connected ? (
            <div className="mt-3 rounded-lg bg-cs2-rose-surface px-3 py-2 font-mono text-[12px] text-cs2-rose-on-surface">
              <span className="flex items-center gap-2">
                <WifiOff className="h-3.5 w-3.5 shrink-0" /> {checkResult.error}
              </span>
            </div>
          ) : null}
        </section>

        {/* 一键校准 */}
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-cs2-text-primary">{t("obscfg.sectionCalibrate")}</div>
            <button
              type="button"
              disabled={statusRefreshing || calibrating}
              onClick={async () => {
                setStatusRefreshing(true);
                try { await refreshSilent(); } finally { setStatusRefreshing(false); }
              }}
              title={t("obscfg.btnRefreshTitle")}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:opacity-40 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${statusRefreshing ? "animate-spin" : ""}`} />
              {t("obscfg.btnRefresh")}
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-cs2-text-secondary">
            {t("obscfg.calibrateDesc")}
          </p>

          {status?.obs_connected ? (
            <div className="mt-3 divide-y divide-cs2-border rounded-lg border border-cs2-border overflow-hidden">
              {statusRows.map((item, i) => (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                  <span className="text-cs2-text-muted w-24 shrink-0">{item.label}</span>
                  <span className="flex-1 font-mono text-cs2-text-secondary">{item.value}</span>
                  {item.skip ? (
                    <span className="text-cs2-text-muted">—</span>
                  ) : item.infoOnly ? (
                    item.outputPath ? (
                      <button
                        type="button"
                        title={t("obscfg.btnOpenFolderTitle")}
                        onClick={() => API.post("/open-folder", { path: item.outputPath }).catch(() => {})}
                        className="flex items-center gap-1 rounded px-2 py-0.5 text-cs2-text-muted transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                        {t("obscfg.btnOpenFolder")}
                      </button>
                    ) : (
                      <span className="text-cs2-text-muted">—</span>
                    )
                  ) : item.ok ? (
                    <span className="flex items-center gap-1 text-cs2-text-success">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      {t("obscfg.statusOk")}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-cs2-amber-on-surface">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      {item.issue}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void handleCalibrate()}
            disabled={batchRecording || calibrating || !status?.obs_connected || !hasIssues}
            title={
              !status?.obs_connected
                ? t("obscfg.btnTitleNotConnected")
                : !hasIssues
                  ? t("obscfg.btnTitleAllOk")
                  : batchRecording
                    ? t("obscfg.btnTitleRecording")
                    : ""
            }
            className={[
              "mt-3 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-[12px] font-bold transition-colors",
              hasIssues && status?.obs_connected && !batchRecording && !calibrating
                ? "bg-cs2-accent text-cs2-text-on-accent hover:brightness-110"
                : "border border-cs2-border bg-cs2-bg-input text-cs2-text-muted cursor-not-allowed opacity-50",
            ].join(" ")}
          >
            {calibrating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {hasIssues ? t("obscfg.btnFix") : t("obscfg.btnNoIssues")}
          </button>

          {calibrateResult?.changed?.length > 0 ? (
            <div className="mt-3 space-y-1">
              {calibrateResult.changed.map((msg, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px] text-cs2-text-success">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {msg}
                </div>
              ))}
            </div>
          ) : null}
          {calibrateResult?.restart_obs_required ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-cs2-amber-on-surface/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-cs2-amber-on-surface">
              <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("obscfg.restartRequired")}</span>
            </div>
          ) : null}
        </section>
      </PageContainer>
    </div>
  );
}
