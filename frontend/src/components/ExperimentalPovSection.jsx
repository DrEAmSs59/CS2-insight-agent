import { useEffect, useState } from "react";
import axios from "axios";

const API = axios.create({ baseURL: "/api" });

/**
 * 实验性 POV：与常用参数 / 录制前观战弹窗共用；勾选写入 experimental.pov_enabled。
 * POV 开启时可调节雷达与 HUD 正上方玩家显示（写入预热参数）。
 */
export default function ExperimentalPovSection({
  visible,
  experimentalPovEnabled,
  onExperimentalPovChange,
  checkboxDisabled = false,
  povRadarMode = 0,
  onPovRadarModeChange,
  povTeamcounterNumeric = false,
  onPovTeamcounterNumericChange,
  omitEyebrow = false,
  className,
}) {
  const [povNeedsRestore, setPovNeedsRestore] = useState(false);
  const [povStatusLoading, setPovStatusLoading] = useState(false);
  const [povRestoreBusy, setPovRestoreBusy] = useState(false);

  const radarVal = povRadarMode === 0 ? 0 : -1;

  useEffect(() => {
    if (!visible) return;
    setPovStatusLoading(true);
    (async () => {
      try {
        const { data } = await API.get("experimental/pov/status");
        setPovNeedsRestore(!!data?.needs_restore);
      } catch {
        setPovNeedsRestore(false);
      } finally {
        setPovStatusLoading(false);
      }
    })();
  }, [visible, experimentalPovEnabled]);

  const rootClass =
    className ??
    "rounded-lg border border-amber-500/25 bg-cs2-amber-surface p-4";

  return (
    <section className={rootClass}>
      {!omitEyebrow ? (
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-cs2-amber-on-surface">实验性功能</p>
      ) : null}
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input/50 px-3 py-2">
        <input
          type="checkbox"
          disabled={checkboxDisabled || !onExperimentalPovChange}
          checked={!!experimentalPovEnabled}
          onChange={(e) => onExperimentalPovChange?.(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-40"
        />
        <span className="min-w-0 text-[12px] leading-snug text-cs2-text-primary">
          <span className="font-semibold text-cs2-amber-on-surface/95">POV HUD 增强</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-cs2-text-muted">
            开启后，录制本地 Demo 时会使用更接近玩家第一人称的 HUD 风格。
            <br />
            注意：该功能为实验性功能；会临时安装 pov.vpk；会临时修改 CS2 的 gameinfo.gi；录制结束后会自动恢复；会强制使用
            -insecure 启动 CS2；仅用于本地 Demo 回放录制，不要用于连接服务器。
          </span>
        </span>
      </label>
      {experimentalPovEnabled ? (
        <p className="mt-2 text-[11px] leading-relaxed text-cs2-amber-on-surface">
          POV 已启用：部分 HUD / TrueView / 观战按键提示等已由 POV 模式接管；雷达与 HUD 正上方玩家显示可在下方选择。
        </p>
      ) : null}

      {experimentalPovEnabled && onPovRadarModeChange && onPovTeamcounterNumericChange ? (
        <div className="mt-3 space-y-4 rounded-lg border border-cs2-border bg-cs2-bg-input/30 px-3 py-2.5">
          <label className="block text-[11px] text-cs2-text-secondary">
            <span className="mb-1 block font-medium text-cs2-text-secondary">雷达</span>
            <select
              value={String(radarVal)}
              onChange={(e) => onPovRadarModeChange(parseInt(e.target.value, 10))}
              className="mt-1 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-xs text-cs2-text-primary outline-none focus:border-cs2-accent/50"
            >
              <option value="-1">隐藏雷达（cl_drawhud_force_radar -1）</option>
              <option value="0">显示雷达（cl_drawhud_force_radar 0）</option>
            </select>
            <span className="mt-1 block text-[10px] leading-relaxed text-cs2-text-muted">
              当前 POV 资源未改雷达样式时，可隐藏雷达或按游戏默认显示。
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-cs2-border bg-cs2-bg-input/40 px-2 py-2">
            <input
              type="checkbox"
              checked={!!povTeamcounterNumeric}
              onChange={(e) => onPovTeamcounterNumericChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
            />
            <span className="min-w-0 text-[11px] leading-snug text-cs2-text-secondary">
              <span className="font-semibold text-cs2-text-primary">局内玩家显示（存活人数）</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-cs2-text-muted">
                <code className="text-cs2-accent/90">cl_teamcounter_playercount_instead_of_avatars</code>
                ：勾选后 HUD 正上方为<strong className="text-cs2-text-secondary">敌我存活人数</strong>
                （可降低 pov.vpk 下敌方头像旁血量信息干扰）；取消勾选为<strong className="text-cs2-text-secondary">双方十人头像</strong>。
              </span>
            </span>
          </label>
        </div>
      ) : null}

      <div className="mt-2 rounded border border-cs2-border bg-cs2-bg-input/40 px-2.5 py-2 text-[11px] leading-relaxed text-cs2-text-muted">
        POV 是实验性功能，仅用于本地 Demo 回放录制。开启后程序会临时安装 pov.vpk，并临时修改 CS2 的 gameinfo.gi。录制完成后会自动恢复。POV
        模式会强制使用 -insecure 启动 CS2，不能用于连接 VAC 安全服务器。
      </div>

      {povNeedsRestore && !povStatusLoading ? (
        <div className="mt-3 rounded border border-rose-500/35 bg-cs2-rose-surface px-2.5 py-2 text-[11px] text-cs2-rose-on-surface">
          <p>检测到上次 POV HUD 修改尚未恢复。请关闭 CS2 后点击「恢复 POV 修改」。</p>
          <button
            type="button"
            disabled={povRestoreBusy}
            onClick={async () => {
              setPovRestoreBusy(true);
              try {
                await API.post("experimental/pov/restore");
                setPovNeedsRestore(false);
              } catch {
                /* ignore */
              } finally {
                setPovRestoreBusy(false);
              }
            }}
            className="mt-2 rounded border border-rose-400/40 px-2 py-1 text-[11px] font-semibold text-rose-100 hover:bg-cs2-rose-surface disabled:opacity-40"
          >
            {povRestoreBusy ? "恢复中…" : "恢复 POV 修改"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
