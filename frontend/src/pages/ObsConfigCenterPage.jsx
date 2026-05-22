import { useCallback, useEffect, useRef, useState } from "react";
import API from "../api/api";
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, RefreshCw, RotateCcw, ScanSearch, Wifi, WifiOff } from "lucide-react";
import PageContainer from "../components/PageContainer";
import { useAppShell } from "../context/AppShellContext";
import { calibrateObs, getObsConfigStatus } from "../api/obsConfigCenter";
import { obsConfigHasIssues } from "../utils/obsConfigHealth";

export default function ObsConfigCenterPage() {
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
      setErrorText(e.response?.data?.detail || e.message || "自动探测失败");
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
      setErrorText(e.response?.data?.detail || e.message || "加载失败");
    }
  }, [fetchStatus]);

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
      setErrorText(e.response?.data?.detail || e.message || "配置检查失败");
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
        n > 0 ? `校准完成，已修正 ${n} 项配置` : "校准完成，OBS 配置均正常",
        { autoDismissMs: 8000 },
      );
      await refreshSilent();
    } catch (e) {
      setErrorText(e.response?.data?.detail || e.message || "校准失败");
    } finally {
      setCalibrating(false);
    }
  };

  const FORMAT_LABELS = {
    hybrid_mp4: "混合 MP4",
    mp4: "MP4",
    mkv: "MKV",
    mov: "MOV",
    ts: "TS",
    fragmented_mp4: "分段 MP4",
  };
  const QUALITY_LABELS = {
    Stream: "与串流一致",
    Small: "高质量，中等文件大小",
    HQ: "近似无损，大文件大小",
    Lossless: "无损，非常大的文件大小",
  };

  const hasIssues = obsConfigHasIssues(status);

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto">
      <PageContainer>
        <div>
          <h1 className="text-lg font-bold tracking-wide text-cs2-text-primary">OBS 配置中心</h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-cs2-text-secondary">
            一键校准 OBS 录制环境，自动修复画布/输出分辨率错位、4:3 黑边、Game Capture 源缺失、录像格式错误等问题。
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
            <h2 className="text-sm font-semibold text-cs2-text-primary">OBS 程序设置</h2>
            <button
              type="button"
              onClick={() => void handleConfigCheck()}
              disabled={checking}
              title="配置检查"
              className="shrink-0 flex items-center gap-1.5 rounded-lg border border-cs2-border bg-cs2-bg-input px-4 py-2 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:bg-cs2-bg-hover disabled:opacity-50"
            >
              {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {checking ? "检查中" : "配置检查"}
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-cs2-text-secondary">
            配置 OBS 启动路径与 WebSocket 连接信息，用于录制前自动拉起 OBS 并控制回放。
          </p>

          {/* 启动配置 */}
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold text-cs2-text-primary">启动配置</div>
              {checkResult != null && (
                <span className={`inline-flex items-center gap-1.5 font-mono text-[12px] ${checkResult.path_ok ? "text-cs2-text-success" : "text-cs2-amber-on-surface"}`}>
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  路径正确
                </span>
              )}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-secondary">
              填写 OBS 可执行文件的完整路径，用于录制前自动启动 OBS。
            </p>
            <div className="mt-2 space-y-2">
              <input
                type="text"
                value={obsConfig.obs_path ?? ""}
                onChange={(e) => setObsConfig({ ...obsConfig, obs_path: e.target.value })}
                placeholder="例如 C:\Program Files\obs-studio\bin\64bit\obs64.exe"
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors placeholder:text-cs2-text-muted/80 focus:border-cs2-accent/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void detectObsPath()}
                disabled={detectingObs}
                title="自动探测 OBS 安装路径"
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input py-2 text-xs font-semibold transition-colors hover:border-cs2-accent/50 disabled:opacity-50"
              >
                {detectingObs ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ScanSearch className="h-3.5 w-3.5" />
                )}
                {detectingObs ? "探测中…" : "自动探测 OBS"}
              </button>
            </div>
          </div>

          {/* 连接配置 */}
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold text-cs2-text-primary">连接配置</div>
              {checkResult != null ? (
                checkResult.connected ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-text-success">
                    <Wifi className="h-3.5 w-3.5 shrink-0" />
                    连接正确{checkResult.obs_version ? ` · ${checkResult.obs_version}` : ""}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-amber-on-surface">
                    <WifiOff className="h-3.5 w-3.5 shrink-0" />
                    连接失败
                  </span>
                )
              ) : status != null ? (
                status.obs_connected ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-text-success">
                    <Wifi className="h-3.5 w-3.5 shrink-0" />
                    已连接{status.obs_version ? ` · ${status.obs_version}` : ""}
                  </span>
                ) : null
              ) : null}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-secondary">
              与 OBS 菜单栏「工具 → WebSocket 服务器设置」中的主机、端口、密码保持一致。
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  主机地址
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
                  端口
                </label>
                <input
                  type="number"
                  value={obsConfig.port ?? 4455}
                  onChange={(e) => setObsConfig({ ...obsConfig, port: Number(e.target.value) })}
                  className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors focus:border-cs2-accent/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                  密码
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
            <div className="text-sm font-semibold text-cs2-text-primary">一键校准</div>
            <button
              type="button"
              disabled={statusRefreshing || calibrating}
              onClick={async () => {
                setStatusRefreshing(true);
                try { await refreshSilent(); } finally { setStatusRefreshing(false); }
              }}
              title="刷新配置状态"
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:opacity-40 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${statusRefreshing ? "animate-spin" : ""}`} />
              刷新
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-cs2-text-secondary">
            检测并修正 OBS 录制环境中的常见配置问题。仅操作 CS2 Insight 专用场景，不影响其他 OBS 场景。
          </p>

          {status?.obs_connected ? (
            <div className="mt-3 divide-y divide-cs2-border rounded-lg border border-cs2-border overflow-hidden">
              {[
                {
                  label: "画布分辨率",
                  value: `${status.video?.base_width ?? 0}×${status.video?.base_height ?? 0}`,
                  ok: status.video?.base_width === status.monitor?.width && status.video?.base_height === status.monitor?.height,
                  issue: `应为 ${status.monitor?.width ?? "?"}×${status.monitor?.height ?? "?"}（主显示器）`,
                },
                {
                  label: "输出分辨率",
                  value: `${status.video?.output_width ?? 0}×${status.video?.output_height ?? 0}`,
                  ok: status.video?.output_width === status.monitor?.width && status.video?.output_height === status.monitor?.height,
                  issue: `应为 ${status.monitor?.width ?? "?"}×${status.monitor?.height ?? "?"}（主显示器）`,
                },
                {
                  label: "CS2 Insight 场景",
                  value: status.scene?.dedicated_scene_exists ? "已存在" : "不存在",
                  ok: status.scene?.dedicated_scene_exists ?? false,
                  issue: "场景不存在，将自动创建",
                },
                {
                  label: "Game Capture 源",
                  value: !status.scene?.dedicated_scene_exists
                    ? "—"
                    : status.scene?.capture_source_exists
                      ? "已存在"
                      : "不存在",
                  ok: status.scene?.dedicated_scene_exists ? (status.scene?.capture_source_exists ?? false) : true,
                  issue: "Game Capture 源不存在，将自动创建",
                  skip: !status.scene?.dedicated_scene_exists,
                },
                {
                  label: "画面拉伸",
                  value: !status.scene?.capture_source_exists
                    ? "—"
                    : status.scene?.source_fit_to_canvas
                      ? "填满画布"
                      : "未填满",
                  ok: status.scene?.capture_source_exists ? (status.scene?.source_fit_to_canvas ?? false) : true,
                  issue: "未填满画布，可能有 4:3 黑边",
                  skip: !status.scene?.capture_source_exists,
                },
                {
                  label: "录像格式",
                  value: FORMAT_LABELS[status.recording?.format] ?? status.recording?.format ?? "未知",
                  ok: status.recording?.format === "hybrid_mp4",
                  issue: `当前：${FORMAT_LABELS[status.recording?.format] ?? status.recording?.format ?? "未知"}，应为混合 MP4`,
                },
                {
                  label: "录像质量",
                  value: QUALITY_LABELS[status.recording?.rec_quality] ?? status.recording?.rec_quality ?? "未知",
                  ok: status.recording?.rec_quality !== "Stream" && !!status.recording?.rec_quality,
                  issue: "当前：与串流一致，可能无法正常录制",
                },
                {
                  label: "录像输出目录",
                  value: status.recording?.output_path || "未配置（OBS 将使用默认路径）",
                  ok: true,
                  infoOnly: true,
                  outputPath: status.recording?.output_path || "",
                },
              ].map((item, i) => (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                  <span className="text-cs2-text-muted w-24 shrink-0">{item.label}</span>
                  <span className="flex-1 font-mono text-cs2-text-secondary">{item.value}</span>
                  {item.skip ? (
                    <span className="text-cs2-text-muted">—</span>
                  ) : item.infoOnly ? (
                    item.outputPath ? (
                      <button
                        type="button"
                        title="在资源管理器中打开"
                        onClick={() => API.post("/open-folder", { path: item.outputPath }).catch(() => {})}
                        className="flex items-center gap-1 rounded px-2 py-0.5 text-cs2-text-muted transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                        打开
                      </button>
                    ) : (
                      <span className="text-cs2-text-muted">—</span>
                    )
                  ) : item.ok ? (
                    <span className="flex items-center gap-1 text-cs2-text-success">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      正常
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
                ? "请先连接 OBS WebSocket"
                : !hasIssues
                  ? "所有配置均正常"
                  : batchRecording
                    ? "批量录制进行中"
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
            {hasIssues ? "一键修复" : "配置正常，无需修复"}
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
              <span>录像编码器已更改，<strong>需要重启 OBS</strong> 后新设置才会生效，重启前录制仍会失败。</span>
            </div>
          ) : null}
        </section>
      </PageContainer>
    </div>
  );
}
