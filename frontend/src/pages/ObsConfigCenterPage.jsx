import { useCallback, useEffect, useRef, useState } from "react";
import API from "../api/api";
import { AlertTriangle, CheckCircle2, Loader2, Wifi, WifiOff } from "lucide-react";
import PageContainer from "../components/PageContainer";
import { useAppShell } from "../context/AppShellContext";
import { calibrateObs, getObsConfigStatus } from "../api/obsConfigCenter";

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
  const [errorText, setErrorText] = useState("");
  const [obsTesting, setObsTesting] = useState(false);
  const [obsTestResult, setObsTestResult] = useState(null);

  const obsConfigRef = useRef(obsConfig);
  obsConfigRef.current = obsConfig;

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

  useEffect(() => {
    void refreshSilent();
  }, [refreshSilent]);

  const testObsConnection = async () => {
    setObsTesting(true);
    setObsTestResult(null);
    try {
      const { data } = await API.post("/obs/test", obsConfigRef.current);
      if (data?.ok) {
        await persistObsConfig?.();
        await refreshSilent();
        setStatus((prev) => {
          if (!prev) return prev;
          const ver = data.obs_version || prev.obs_version;
          return { ...prev, obs_connected: true, ...(ver ? { obs_version: ver } : {}) };
        });
      } else {
        setObsTestResult({ ok: false, error: data?.error || "连接失败" });
      }
    } catch (e) {
      setObsTestResult({ ok: false, error: e?.response?.data?.detail || e.message });
    } finally {
      setObsTesting(false);
    }
  };

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

  const hasIssues = !!(
    status?.obs_connected && (
      status.video?.base_width !== status.monitor?.width ||
      status.video?.base_height !== status.monitor?.height ||
      !status.scene?.dedicated_scene_exists ||
      !status.scene?.capture_source_exists ||
      !status.scene?.source_fit_to_canvas ||
      status.recording?.format !== "hybrid_mp4" ||
      status.recording?.rec_quality === "Stream"
    )
  );

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto">
      <PageContainer>
        <div>
          <h1 className="text-lg font-bold tracking-wide text-cs2-text-primary">OBS 配置中心</h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-cs2-text-secondary">
            一键校准 OBS 录制环境，自动修复画布分辨率错位、4:3 黑边、Game Capture 源缺失、录像格式错误等问题。
          </p>
        </div>

        {errorText ? (
          <div className="mt-3 rounded-lg border border-cs2-border-error/40 bg-cs2-rose-surface px-3 py-2 text-[12px] text-cs2-rose-on-surface">
            {errorText}
          </div>
        ) : null}

        {/* OBS WebSocket 连接 */}
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-cs2-text-primary">OBS WebSocket 连接</div>
              <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-muted">
                与 OBS「工具 → WebSocket 服务器设置」中的主机、端口、密码一致；保存配置后录制均使用该连接。
              </p>
            </div>
            {status != null ? (
              <div className="shrink-0 text-right">
                {status.obs_connected ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-text-success">
                    <Wifi className="h-3.5 w-3.5 shrink-0" />
                    已连接{status.obs_version ? ` · ${status.obs_version}` : ""}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-amber-on-surface">
                    <WifiOff className="h-3.5 w-3.5 shrink-0" />
                    未连接
                  </span>
                )}
              </div>
            ) : null}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
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
          <button
            type="button"
            onClick={() => void testObsConnection()}
            disabled={obsTesting}
            className="mt-3 w-full rounded-lg border border-cs2-border bg-cs2-bg-input py-2.5 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:bg-cs2-bg-hover disabled:opacity-50 sm:w-auto sm:px-6"
          >
            {obsTesting ? "测试中…" : "测试连接"}
          </button>
          {obsTestResult && !obsTestResult.ok ? (
            <div className="mt-3 rounded-lg bg-cs2-rose-surface px-3 py-2 font-mono text-[12px] text-cs2-rose-on-surface">
              <span className="flex items-center gap-2">
                <WifiOff className="h-3.5 w-3.5 shrink-0" /> {obsTestResult.error}
              </span>
            </div>
          ) : null}
        </section>

        {/* 一键校准 */}
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-sm">
          <div className="text-sm font-semibold text-cs2-text-primary">一键校准</div>
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
                  value: status.recording?.format || "未知",
                  ok: status.recording?.format === "hybrid_mp4",
                  issue: `当前：${status.recording?.format || "未知"}，应为混合 MP4`,
                },
                {
                  label: "录像质量",
                  value: status.recording?.rec_quality === "Stream" ? "与串流一致" : (status.recording?.rec_quality || "未知"),
                  ok: status.recording?.rec_quality !== "Stream" && !!status.recording?.rec_quality,
                  issue: "当前：与串流一致，录制质量可能降低",
                },
              ].map((item, i) => (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                  <span className="text-cs2-text-muted w-24 shrink-0">{item.label}</span>
                  <span className="flex-1 font-mono text-cs2-text-secondary">{item.value}</span>
                  {item.skip ? (
                    <span className="text-cs2-text-muted">—</span>
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
        </section>
      </PageContainer>
    </div>
  );
}
