import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { Loader2, Shield, Upload, Wifi, WifiOff, X } from "lucide-react";
import { useAppShell } from "../context/AppShellContext";
import {
  applyRecommendedObsPreset,
  getObsConfigStatus,
  importNativeObsConfig,
} from "../api/obsConfigCenter";

const ALLOWED_NATIVE_FILES = ["basic.ini", "recordEncoder.json", "streamEncoder.json"];

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
  const [applying, setApplying] = useState(false);
  const [importing, setImporting] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [obsTesting, setObsTesting] = useState(false);
  const [obsTestResult, setObsTestResult] = useState(null);
  const [applyPresetModalOpen, setApplyPresetModalOpen] = useState(false);

  const obsConfigRef = useRef(obsConfig);
  obsConfigRef.current = obsConfig;

  const nativeInputRef = useRef(null);

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
      const { data } = await axios.post("/api/obs/test", obsConfigRef.current);
      if (data?.ok) {
        await persistObsConfig?.();
        await refreshSilent();
        setStatus((prev) => {
          if (!prev) return prev;
          const ver = data.obs_version || prev.obs_version;
          return {
            ...prev,
            obs_connected: true,
            ...(ver ? { obs_version: ver } : {}),
          };
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

  const executeApplyRecommended = async () => {
    setApplying(true);
    setErrorText("");
    try {
      const data = await applyRecommendedObsPreset({
        obs: obsConfigRef.current,
        create_backup: true,
        fix_scene: true,
      });
      const msg = data.message || "已应用推荐预设。";
      const restartHint = data.restart_obs_required ? "若提示重启 OBS，请关闭并重新打开 OBS。" : "";
      const toastBody = [msg, restartHint].filter(Boolean).join(" ");
      setProgressText(toastBody, { autoDismissMs: 14000 });
      await refreshSilent();
    } catch (e) {
      setErrorText(e.response?.data?.detail || e.message || "应用失败");
    } finally {
      setApplying(false);
    }
  };

  const confirmApplyRecommended = () => {
    setApplyPresetModalOpen(false);
    void executeApplyRecommended();
  };

  const handleNativeImport = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const bad = files.filter((f) => !ALLOWED_NATIVE_FILES.includes(f.name));
    if (bad.length) {
      window.alert(`仅允许：${ALLOWED_NATIVE_FILES.join(", ")}`);
      return;
    }
    if (
      !window.confirm(
        "OBS 原生配置来自其他电脑时可能不兼容。\n不同电脑的编码器、路径、音频设备可能不一致。\n\n是否继续？",
      )
    ) {
      return;
    }
    setImporting(true);
    setErrorText("");
    try {
      const data = await importNativeObsConfig(files, true);
      const msg = data.message || "已导入。建议重启 OBS 后再使用录制。";
      const imp = data.imported?.length ?? 0;
      const sk = data.skipped?.length ?? 0;
      const countLine = `已写入 ${imp} 个文件${sk ? `，跳过 ${sk} 个` : ""}。`;
      const restartHint = data.restart_obs_required ? "若提示重启 OBS，请关闭并重新打开 OBS。" : "";
      setProgressText([countLine, msg, restartHint].filter(Boolean).join(" "), {
        autoDismissMs: 14000,
      });
      await refreshSilent();
    } catch (err) {
      setErrorText(err.response?.data?.detail || err.message || "导入失败");
    } finally {
      setImporting(false);
    }
  };

  const applyDisabled = batchRecording || applying || importing;

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto px-4 py-3 pb-16 sm:px-5">
      <div>
        <h1 className="text-lg font-bold tracking-wide text-white">OBS 配置中心</h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-zinc-400">
          一键修复 OBS 录制环境，解决画面不拉伸、与串流一致、编码器异常、录制失败等常见问题。
          使用下方「推荐录制预设」或「导入 OBS 原生配置文件」时，请先完全退出 OBS 再操作，完成后再打开 OBS。
        </p>
      </div>

      {errorText ? (
        <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-100">
          {errorText}
        </div>
      ) : null}

      <section className="mt-4 rounded-xl border border-white/10 bg-cs2-bg-card/80 p-4 shadow-lg shadow-black/20">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white">OBS WebSocket 连接</div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              与 OBS「工具 → WebSocket 服务器设置」中的主机、端口、密码一致；保存配置后录制均使用该连接。
            </p>
          </div>
          {status != null ? (
            <div className="shrink-0 text-right">
              {status.obs_connected ? (
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-300">
                  <Wifi className="h-3.5 w-3.5 shrink-0" />
                  已连接
                  {status.obs_version ? ` · ${status.obs_version}` : ""}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-amber-300">
                  <WifiOff className="h-3.5 w-3.5 shrink-0" />
                  未连接
                </span>
              )}
            </div>
          ) : null}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">主机地址</label>
            <input
              type="text"
              value={obsConfig.host ?? ""}
              onChange={(e) => setObsConfig({ ...obsConfig, host: e.target.value })}
              className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white transition-colors focus:border-cs2-orange/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">端口</label>
            <input
              type="number"
              value={obsConfig.port ?? 4455}
              onChange={(e) => setObsConfig({ ...obsConfig, port: Number(e.target.value) })}
              className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white transition-colors focus:border-cs2-orange/50 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">密码</label>
            <input
              type="password"
              value={obsConfig.password ?? ""}
              placeholder={obsPasswordPlaceholder}
              onChange={(e) => setObsConfig({ ...obsConfig, password: e.target.value })}
              onFocus={() => handleObsPasswordFocus?.()}
              onBlur={() => handleObsPasswordBlur?.()}
              autoComplete="new-password"
              className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-white transition-colors placeholder:text-zinc-500/80 focus:border-cs2-orange/50 focus:outline-none"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={() => void testObsConnection()}
          disabled={obsTesting}
          className="mt-3 w-full rounded-lg border border-white/15 bg-white/[0.06] py-2.5 text-[12px] font-semibold text-zinc-100 transition-colors hover:bg-white/[0.1] disabled:opacity-50 sm:w-auto sm:px-6"
        >
          {obsTesting ? "测试中…" : "测试连接"}
        </button>
        {obsTestResult && !obsTestResult.ok ? (
          <div className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 font-mono text-[11px] text-red-200">
            <span className="flex items-center gap-2">
              <WifiOff className="h-3.5 w-3.5 shrink-0" /> {obsTestResult.error}
            </span>
          </div>
        ) : null}
      </section>

      <div className="mt-4 space-y-4">
        <section className="rounded-xl border border-white/10 bg-cs2-bg-card/80 p-4 shadow-lg shadow-black/20">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Shield className="h-4 w-4 text-cs2-orange" />
            推荐录制预设
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-zinc-400">
            <strong className="font-semibold text-zinc-300">请先完全退出 OBS（确保进程已结束）再应用预设</strong>
            ，否则覆盖本机 %APPDATA%\obs-studio\basic\profiles\ 里的 basic.ini 会不生效。应用完成后请重新打开 OBS。
            预设仅能保证正常录制 demo；应用前请确认本机 OBS 有无其他用途，避免覆盖设置带来麻烦。
            视频输出路径等会随模板变为常见默认值（如「视频」文件夹），若需修改请在 OBS 设置中调整。
          </p>
          <button
            type="button"
            onClick={() => setApplyPresetModalOpen(true)}
            disabled={applyDisabled}
            title={batchRecording ? "批量录制进行中" : ""}
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-cs2-orange px-4 py-2 text-[12px] font-bold text-black hover:bg-cs2-orange/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            一键应用推荐预设
          </button>
        </section>

        <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4 shadow-lg shadow-black/20">
          <div className="text-sm font-semibold text-amber-100">高级：导入 OBS 原生配置文件</div>
          <p className="mt-2 text-[12px] leading-relaxed text-amber-100/80">
            适合熟悉 OBS 的用户。原生配置可能包含本机路径、编码器等，不同电脑之间不一定兼容。
            <strong className="block mt-2 font-semibold text-amber-50">请先完全退出 OBS（确保进程已结束）再导入</strong>
            否则覆盖 %APPDATA%\obs-studio\basic\profiles\ 目录无法生效；导入完成后重新打开 OBS。
          </p>
          <input
            ref={nativeInputRef}
            type="file"
            accept=".ini,.json"
            multiple
            className="hidden"
            onChange={(e) => void handleNativeImport(e)}
          />
          <button
            type="button"
            disabled={importing || batchRecording}
            onClick={() => nativeInputRef.current?.click()}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-400/40 bg-black/30 px-3 py-2 text-[11px] font-semibold text-amber-50 hover:bg-black/45 disabled:opacity-40"
          >
            <Upload className="h-3.5 w-3.5" />
            导入 OBS 原生配置文件
          </button>
          <p className="mt-2 font-mono text-[10px] text-amber-100/70">允许：{ALLOWED_NATIVE_FILES.join(", ")}</p>
        </section>
      </div>

      {applyPresetModalOpen ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-3 py-6 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="obs-apply-preset-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setApplyPresetModalOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-cs2-bg-card p-4 shadow-2xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <h3 id="obs-apply-preset-title" className="text-sm font-bold text-zinc-200">
                应用推荐录制预设
              </h3>
              <button
                type="button"
                onClick={() => setApplyPresetModalOpen(false)}
                className="rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-white"
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-[12px] leading-relaxed text-zinc-400">
              <strong className="font-semibold text-zinc-300">请先完全退出 OBS 再确认应用</strong>
              ：OBS 在运行时写入配置文件通常无法可靠生效。应用完成后重新启动 OBS。
              若本机 OBS 另有用途，请注意预设会覆盖当前 Profile 下的设置；视频输出路径等可之后在 OBS 设置里修改。
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setApplyPresetModalOpen(false)}
                className="rounded-lg border border-white/15 bg-white/[0.06] px-4 py-2 text-[12px] font-semibold text-zinc-200 transition-colors hover:bg-white/[0.1]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmApplyRecommended}
                className="inline-flex items-center gap-2 rounded-lg bg-cs2-orange px-4 py-2 text-[12px] font-bold text-black hover:bg-cs2-orange/90"
              >
                确认应用
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
