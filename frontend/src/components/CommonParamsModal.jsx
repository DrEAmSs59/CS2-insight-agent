import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  buildWarmupConsoleCommands,
  OptionRow,
  RECORD_WARMUP_DEFAULT_OPTIONS,
  SectionHeader,
} from "./RecordWarmupModal";
import { BACKEND_DEFAULT_PACING, useRecordingQueue } from "../stores/recordingQueueStore";
import { warmupUiOptsToPersisted, validateWarmupResolution } from "../utils/warmupDefaults";

/** 未写入配置时的展示用回退（与队列微调面板一致） */
const FB_VIC_PRE = 1.5;
const FB_VIC_POST = 1.0;
const FB_KILL_PRE = 3.0;
const FB_KILL_POST = 1.5;

/**
 * 常用参数：内联编辑「全局节奏（数值）+ 入队默认 POV」与「录制前观战默认选项」，写入 cs2-insight.config.json。
 */
export default function CommonParamsModal({
  open,
  onClose,
  batchRecording,
  savedWarmupDefaults,
  onPersistWarmupDefaults,
}) {
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing = useRecordingQueue((s) => s.setGlobalPacing);
  const resetNumericGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);

  const post = globalPacing.post_last_sec ?? BACKEND_DEFAULT_PACING.post_last_sec;
  const pre = globalPacing.pre_first_sec ?? BACKEND_DEFAULT_PACING.pre_first_sec;
  const gap = globalPacing.max_gap_sec ?? BACKEND_DEFAULT_PACING.max_gap_sec;

  const victimPovPre = globalPacing.victim_pov_pre_sec ?? FB_VIC_PRE;
  const victimPovPost = globalPacing.victim_pov_post_sec ?? FB_VIC_POST;
  const killerPovPre = globalPacing.killer_pov_pre_sec ?? FB_KILL_PRE;
  const killerPovPost = globalPacing.killer_pov_post_sec ?? FB_KILL_POST;

  const commitPacingNumbers = useCallback(
    (partial) => {
      const next = Object.fromEntries(
        Object.entries(partial).filter(([, v]) => typeof v === "number" && Number.isFinite(v))
      );
      if (Object.keys(next).length) setGlobalPacing(next);
    },
    [setGlobalPacing]
  );

  const [warmupOpts, setWarmupOpts] = useState(RECORD_WARMUP_DEFAULT_OPTIONS);
  const [warmupResolutionError, setWarmupResolutionError] = useState("");

  useEffect(() => {
    if (!open) return;
    setWarmupResolutionError("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const base = { ...RECORD_WARMUP_DEFAULT_OPTIONS };
    const o = savedWarmupDefaults;
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const k of Object.keys(RECORD_WARMUP_DEFAULT_OPTIONS)) {
        if (!Object.prototype.hasOwnProperty.call(o, k) || o[k] === undefined) continue;
        const v = o[k];
        if (k === "resolution_width" || k === "resolution_height") {
          base[k] = v != null && v !== "" ? String(v) : "";
        } else {
          base[k] = v;
        }
      }
    }
    setWarmupOpts(base);
    // 仅在打开时从 props 快照初始化；保存回写父 state 时不重置正在编辑的内容
  }, [open]);

  const patchWarmup = useCallback((patch) => {
    setWarmupOpts((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    if (!open || !onPersistWarmupDefaults) return;
    const t = setTimeout(() => {
      const vr = validateWarmupResolution(warmupOpts);
      if (!vr.ok) {
        setWarmupResolutionError(vr.message);
        return;
      }
      setWarmupResolutionError("");
      onPersistWarmupDefaults(warmupUiOptsToPersisted(warmupOpts));
    }, 500);
    return () => clearTimeout(t);
  }, [warmupOpts, open, onPersistWarmupDefaults]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 px-3 py-6 backdrop-blur-sm sm:px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="common-params-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[min(92vh,820px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-cs2-bg-card shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="min-w-0 pr-2">
            <h2 id="common-params-title" className="text-sm font-bold text-white">
              常用参数管理
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              以下默认值写入{" "}
              <span className="font-mono text-zinc-400">cs2-insight.config.json</span>
              。全局节奏与「入队默认视角」影响<strong className="text-zinc-400">之后新加入队列</strong>
              的片段；录制前观战选项在批量录制确认时也会沿用此处默认值。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <section className="mb-6 rounded-lg border border-white/[0.08] bg-black/25 p-3">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              全局剪辑节奏
            </p>
            <p className="mb-3 text-[10px] leading-relaxed text-zinc-600">
              数值参数与录制队列侧栏「全局节奏设置」同源；恢复数值默认不影响下方入队默认开关与 POV 时序默认值。
            </p>
            <label className="mb-3 block text-[10px] text-zinc-500">
              开场预留 (秒)
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={0.1}
                  disabled={batchRecording}
                  value={pre}
                  onChange={(e) => commitPacingNumbers({ pre_first_sec: parseFloat(e.target.value) })}
                  className="min-w-0 flex-1 accent-cs2-orange disabled:opacity-40"
                />
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  disabled={batchRecording}
                  value={pre}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) commitPacingNumbers({ pre_first_sec: n });
                  }}
                  className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200 disabled:opacity-40"
                />
              </div>
            </label>
            <label className="mb-3 block text-[10px] text-zinc-500">
              结尾留白 (秒)
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.1}
                  disabled={batchRecording}
                  value={post}
                  onChange={(e) => commitPacingNumbers({ post_last_sec: parseFloat(e.target.value) })}
                  className="min-w-0 flex-1 accent-cs2-orange disabled:opacity-40"
                />
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  disabled={batchRecording}
                  value={post}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) commitPacingNumbers({ post_last_sec: n });
                  }}
                  className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200 disabled:opacity-40"
                />
              </div>
            </label>
            <label className="mb-3 block text-[10px] text-zinc-500">
              防跳剪阈值 (秒)
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="range"
                  min={2}
                  max={70}
                  step={0.5}
                  disabled={batchRecording}
                  value={gap}
                  onChange={(e) => commitPacingNumbers({ max_gap_sec: parseFloat(e.target.value) })}
                  className="min-w-0 flex-1 accent-cs2-orange disabled:opacity-40"
                />
                <input
                  type="number"
                  step={0.5}
                  min={0.5}
                  disabled={batchRecording}
                  value={gap}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) commitPacingNumbers({ max_gap_sec: n });
                  }}
                  className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200 disabled:opacity-40"
                />
              </div>
            </label>

            <button
              type="button"
              disabled={batchRecording}
              onClick={() => resetNumericGlobalPacing()}
              className="mb-4 text-[9px] text-zinc-600 hover:text-zinc-400 disabled:opacity-40"
            >
              恢复数值类节奏为后端内置默认（保留入队默认视角与 POV 时序默认值）
            </button>

            <div className="space-y-2 border-t border-white/[0.06] pt-3">
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2">
                <input
                  type="checkbox"
                  disabled={batchRecording}
                  checked={globalPacing.default_victim_pov === true}
                  onChange={(e) => setGlobalPacing({ default_victim_pov: e.target.checked })}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-40"
                />
                <span className="text-[11px] leading-snug text-zinc-300">
                  新入队片段默认开启「追加受害者视角」（仅对带受害者名单的高光 / 合集高光生效）
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2">
                <input
                  type="checkbox"
                  disabled={batchRecording}
                  checked={globalPacing.default_killer_pov === true}
                  onChange={(e) => setGlobalPacing({ default_killer_pov: e.target.checked })}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange disabled:opacity-40"
                />
                <span className="text-[11px] leading-snug text-zinc-300">
                  新入队片段默认开启「追加击杀者视角」（仅对死亡合集 / 带击杀者的失误片段等生效）
                </span>
              </label>

              <div className="space-y-3 border-t border-white/[0.06] pt-3">
                <p className="text-[10px] font-semibold text-cyan-400/90">受害者视角时序</p>
                <label className="block text-[10px] text-zinc-500">
                  击杀前预留 (秒)
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="range"
                      min={0.5}
                      max={5}
                      step={0.5}
                      disabled={batchRecording}
                      value={victimPovPre}
                      onChange={(e) =>
                        commitPacingNumbers({ victim_pov_pre_sec: parseFloat(e.target.value) })
                      }
                      className="min-w-0 flex-1 accent-cyan-500 disabled:opacity-40"
                    />
                    <input
                      type="number"
                      step={0.5}
                      min={0.5}
                      disabled={batchRecording}
                      value={victimPovPre}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        if (Number.isFinite(n)) commitPacingNumbers({ victim_pov_pre_sec: n });
                      }}
                      className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200 disabled:opacity-40"
                    />
                  </div>
                </label>
                <label className="block text-[10px] text-zinc-500">
                  死亡后停留 (秒)
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={5}
                      step={0.5}
                      disabled={batchRecording}
                      value={victimPovPost}
                      onChange={(e) =>
                        commitPacingNumbers({ victim_pov_post_sec: parseFloat(e.target.value) })
                      }
                      className="min-w-0 flex-1 accent-cyan-500 disabled:opacity-40"
                    />
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      disabled={batchRecording}
                      value={victimPovPost}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        if (Number.isFinite(n)) commitPacingNumbers({ victim_pov_post_sec: n });
                      }}
                      className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200 disabled:opacity-40"
                    />
                  </div>
                </label>

                <p className="pt-1 text-[10px] font-semibold text-amber-400/90">击杀者视角时序</p>
                <label className="block text-[10px] text-zinc-500">
                  击杀前预留 (秒)
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="range"
                      min={0.5}
                      max={5}
                      step={0.5}
                      disabled={batchRecording}
                      value={killerPovPre}
                      onChange={(e) =>
                        commitPacingNumbers({ killer_pov_pre_sec: parseFloat(e.target.value) })
                      }
                      className="min-w-0 flex-1 accent-amber-500 disabled:opacity-40"
                    />
                    <input
                      type="number"
                      step={0.5}
                      min={0.5}
                      disabled={batchRecording}
                      value={killerPovPre}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        if (Number.isFinite(n)) commitPacingNumbers({ killer_pov_pre_sec: n });
                      }}
                      className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200 disabled:opacity-40"
                    />
                  </div>
                </label>
                <label className="block text-[10px] text-zinc-500">
                  死亡后停留 (秒)
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={5}
                      step={0.5}
                      disabled={batchRecording}
                      value={killerPovPost}
                      onChange={(e) =>
                        commitPacingNumbers({ killer_pov_post_sec: parseFloat(e.target.value) })
                      }
                      className="min-w-0 flex-1 accent-amber-500 disabled:opacity-40"
                    />
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      disabled={batchRecording}
                      value={killerPovPost}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        if (Number.isFinite(n)) commitPacingNumbers({ killer_pov_post_sec: n });
                      }}
                      className="w-16 rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[10px] text-zinc-200 disabled:opacity-40"
                    />
                  </div>
                </label>
              </div>
            </div>
          </section>

          <section>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              录制前观战默认选项
            </p>
            <p className="mb-3 text-[10px] leading-relaxed text-zinc-600">
              作为批量录制预热阶段的默认控制台与启动参数；分辨率校验通过后约半秒写入配置。
            </p>

            <div className="space-y-6">
              <section aria-labelledby="cp-sec-visuals">
                <SectionHeader en="Visuals & HUD" zh="视觉与 UI" />
                <div id="cp-sec-visuals" className="space-y-2">
                  <OptionRow
                    checked={warmupOpts.cl_draw_only_deathnotices}
                    onChange={(v) => patchWarmup({ cl_draw_only_deathnotices: v })}
                    title="简化观战 HUD"
                    code="cl_draw_only_deathnotices true"
                  />
                  <OptionRow
                    checked={warmupOpts.hud_showtargetid_hide}
                    onChange={(v) => patchWarmup({ hud_showtargetid_hide: v })}
                    title="隐藏准星目标 ID"
                    code="hud_showtargetid 0"
                  />
                  <OptionRow
                    checked={warmupOpts.tv_nochat}
                    onChange={(v) => patchWarmup({ tv_nochat: v })}
                    title="屏蔽文字聊天"
                    code="tv_nochat 1"
                  />
                  <OptionRow
                    checked={warmupOpts.hide_demo_playback_ui}
                    onChange={(v) => patchWarmup({ hide_demo_playback_ui: v })}
                    title="隐藏 Demo 进度条与回放控制条"
                    code="sv_cheats 1 → demoui false"
                  />
                  <OptionRow
                    checked={warmupOpts.hide_grenade_trajectory_pip}
                    onChange={(v) => patchWarmup({ hide_grenade_trajectory_pip: v })}
                    title="隐藏投掷物轨迹与画中窗"
                    code="sv_grenade_trajectory 0; …"
                  />
                  <OptionRow
                    checked={warmupOpts.spec_show_xray}
                    onChange={(v) => patchWarmup({ spec_show_xray: v })}
                    title="开启 X 光透视"
                    code="spec_show_xray 1 / 0"
                  />
                </div>
              </section>

              <section aria-labelledby="cp-sec-camera">
                <SectionHeader en="Camera & Viewmodel" zh="摄像机与持枪" />
                <div id="cp-sec-camera" className="space-y-2">
                  <div className="rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2.5">
                    <label className="flex cursor-pointer items-center gap-3">
                      <input
                        type="checkbox"
                        checked={warmupOpts.apply_fov}
                        onChange={(e) => patchWarmup({ apply_fov: e.target.checked })}
                        className="h-4 w-4 shrink-0 rounded border-cs2-border accent-cs2-orange"
                      />
                      <span className="text-sm text-zinc-200">
                        应用 FOV（<code className="text-xs text-cs2-orange">fov_cs_debug</code>）
                      </span>
                    </label>
                    <div className="mt-2 flex items-center gap-2 pl-7">
                      <input
                        type="number"
                        min={60}
                        max={120}
                        step={1}
                        value={warmupOpts.fov_cs_debug}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          patchWarmup({
                            fov_cs_debug: Number.isNaN(n) ? 90 : Math.min(120, Math.max(60, n)),
                          });
                        }}
                        disabled={!warmupOpts.apply_fov}
                        className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white disabled:opacity-40"
                      />
                      <span className="text-xs text-zinc-500">默认 90</span>
                    </div>
                  </div>
                  <OptionRow
                    checked={warmupOpts.viewmodel_fov_68}
                    onChange={(v) => patchWarmup({ viewmodel_fov_68: v })}
                    title="开启极限持枪视角"
                    code="viewmodel_fov 68"
                  />
                </div>
              </section>

              <section aria-labelledby="cp-sec-audio">
                <SectionHeader en="Audio & Misc" zh="音频与杂项" />
                <div id="cp-sec-audio" className="space-y-2">
                  <OptionRow
                    checked={warmupOpts.snd_voipvolume_mute}
                    onChange={(v) => patchWarmup({ snd_voipvolume_mute: v })}
                    title="静音游戏内玩家语音"
                    code="snd_voipvolume 0"
                  />
                  <div
                    className={`rounded-lg px-3 py-2.5 ${
                      warmupResolutionError
                        ? "border border-rose-500/45 bg-rose-950/25"
                        : "border border-white/[0.06] bg-black/25"
                    }`}
                  >
                    <p className="mb-2 text-sm font-medium text-zinc-200">
                      启动分辨率（可选，不填则为本机当前游戏设置分辨率）
                    </p>
                    <label className="mb-2 block">
                      <span className="mb-1 block text-[11px] text-zinc-500">屏幕比例（与分辨率联动）</span>
                      <select
                        value={warmupOpts.aspect_ratio}
                        onChange={(e) => patchWarmup({ aspect_ratio: e.target.value })}
                        className="w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white outline-none focus:border-cs2-orange/50"
                      >
                        <option value="">不填写启动分辨率</option>
                        <option value="4:3">4 : 3</option>
                        <option value="16:9">16 : 9</option>
                        <option value="16:10">16 : 10</option>
                      </select>
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-zinc-500">-w</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={warmupOpts.resolution_width}
                        onChange={(e) => patchWarmup({ resolution_width: e.target.value })}
                        className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white placeholder:text-zinc-600"
                      />
                      <span className="font-mono text-xs text-zinc-500">-h</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={warmupOpts.resolution_height}
                        onChange={(e) => patchWarmup({ resolution_height: e.target.value })}
                        className="w-24 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-sm text-white placeholder:text-zinc-600"
                      />
                    </div>
                    {warmupResolutionError ? (
                      <p className="mt-2 text-[11px] leading-snug text-rose-400">{warmupResolutionError}</p>
                    ) : (
                      <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
                        留空宽高则沿用当前分辨率；若填写宽高须选择比例且化简后须匹配（4:3 含游戏内同组的 5:4，如
                        1280×1024）。
                      </p>
                    )}
                  </div>
                </div>
              </section>

              <p className="font-mono text-[10px] leading-relaxed text-zinc-600">
                默认预热将注入{" "}
                {buildWarmupConsoleCommands({
                  ...warmupOpts,
                  spec_show_xray: !!warmupOpts.spec_show_xray,
                }).length}{" "}
                条控制台指令
              </p>
            </div>
          </section>
        </div>

        <div className="shrink-0 border-t border-white/[0.08] bg-black/35 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-cs2-orange py-2 text-sm font-extrabold text-black hover:bg-cs2-orange-light sm:w-auto sm:px-6"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
