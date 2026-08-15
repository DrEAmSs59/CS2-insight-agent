import { useLiteCutTimelineStore } from "../state/timelineStore.js";
import {
  VISUAL_FREEZE_DEFAULT_SEC,
  VISUAL_FREEZE_MAX_SEC,
  VISUAL_FREEZE_MIN_SEC,
  VISUAL_SPEED_DEFAULT,
  VISUAL_SPEED_MAX,
  VISUAL_SPEED_MIN,
} from "../domain/visualMaterial.js";
import { matchingSpeedRampPresetId, SPEED_RAMP_PRESETS, speedRampDisplaySegments, speedRampPointsForPreset } from "./speedRampUiUtils.js";
import { PaneSection, ProSlider, Toggle } from "./PropertyControls.jsx";

export default function SpeedPropertyPane({
  speed = VISUAL_SPEED_DEFAULT,
  onSpeedChange,
  speedKeyframes = [],
  trimIn = 0,
  onSpeedKeyframesChange,
  preservePitch = true,
  onPreservePitchChange,
  reverse = false,
  onReverseChange,
  sourceDuration = 0,
  timelineDuration = 0,
  freezeFrameSec = VISUAL_FREEZE_DEFAULT_SEC,
  onFreezeFrameChange,
  isAudioClip = false,
  supportsSpeedRamp = true,
  supportsPreservePitch = true,
  supportsReverse = true,
  supportsFreeze = true,
}) {
  const beginPropertyEdit = useLiteCutTimelineStore((state) => state.beginPropertyEdit);
  const endPropertyEdit = useLiteCutTimelineStore((state) => state.endPropertyEdit);
  const speedMinPct = VISUAL_SPEED_MIN * 100;
  const speedMaxPct = VISUAL_SPEED_MAX * 100;
  const speedPct = Math.round(Math.max(VISUAL_SPEED_MIN, Math.min(VISUAL_SPEED_MAX, Number(speed) || VISUAL_SPEED_DEFAULT)) * 100);
  const baseDur = Number(sourceDuration) > 0 ? Number(sourceDuration) : 0;
  const safeFreeze = Math.max(VISUAL_FREEZE_MIN_SEC, Math.min(VISUAL_FREEZE_MAX_SEC, Number(freezeFrameSec) || VISUAL_FREEZE_DEFAULT_SEC));
  const hasSpeedRamp = Array.isArray(speedKeyframes) && speedKeyframes.length >= 2;
  const resolvedTimelineDuration = Math.max(0, Number(timelineDuration) || 0);
  const effectiveDur = resolvedTimelineDuration || (baseDur > 0 ? baseDur * (100 / speedPct) + safeFreeze : 0);
  const rampPoints = speedKeyframes.slice().sort((a, b) => (Number(a?.source_sec) || 0) - (Number(b?.source_sec) || 0));
  const activeRampPresetId = hasSpeedRamp ? matchingSpeedRampPresetId(rampPoints, trimIn, baseDur) : null;
  const rampSegments = hasSpeedRamp ? speedRampDisplaySegments(rampPoints, trimIn, baseDur) : [];
  const updateRampPoint = (index, patch) => {
    const next = rampPoints.map((point, pointIndex) => pointIndex === index ? { ...point, ...patch } : point);
    onSpeedKeyframesChange?.(next.sort((a, b) => (Number(a?.source_sec) || 0) - (Number(b?.source_sec) || 0)));
  };
  const setSpeedPct = (pct) => {
    onSpeedKeyframesChange?.([]);
    onSpeedChange?.(Math.max(speedMinPct, Math.min(speedMaxPct, Number(pct) || VISUAL_SPEED_DEFAULT * 100)) / 100);
  };
  const setRamp = (presetId) => {
    const points = speedRampPointsForPreset(presetId, trimIn, baseDur);
    if (points.length) onSpeedKeyframesChange?.(points);
  };
  const applyDiscreteSpeedEdit = (apply) => {
    beginPropertyEdit();
    apply();
    endPropertyEdit();
  };

  return <>
    <PaneSection title={hasSpeedRamp ? "播放方向与音调" : "固定速度"}>
      {!hasSpeedRamp ? <>
        <div className="flex flex-wrap gap-1.5">
          {[50, 75, 100, 125, 150, 200].map((pct) => <button key={pct} type="button" onClick={() => applyDiscreteSpeedEdit(() => setSpeedPct(pct))} className={`rounded-lg border px-2.5 py-1 text-[10px] font-bold transition-colors ${speedPct === pct ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/50 text-cs2-text-muted hover:border-cs2-border-focus"}`}>{pct}%</button>)}
        </div>
        <ProSlider label="整段速度 (%)" value={speedPct} onChange={setSpeedPct} min={speedMinPct} max={speedMaxPct} resetValue={VISUAL_SPEED_DEFAULT * 100} />
      </> : <div className="litecut-property-inline-group flex items-center justify-between gap-3 px-1 py-1">
        <div><p className="text-[11px] font-semibold text-cs2-accent">当前使用分段变速</p><p className="mt-0.5 text-[9px] text-cs2-text-muted">固定速度控件已隐藏，避免误操作清除分段。</p></div>
        <button type="button" onClick={() => applyDiscreteSpeedEdit(() => onSpeedKeyframesChange?.([]))} className="shrink-0 rounded-md border border-cs2-accent/40 px-2 py-1 text-[10px] font-semibold text-cs2-accent hover:bg-cs2-accent/10">切换为固定速度</button>
      </div>}
      {supportsPreservePitch ? <div className="flex items-center justify-between"><span className="text-[11px] text-cs2-text-secondary">保持音调</span><Toggle checked={Boolean(preservePitch)} onChange={(value) => onPreservePitchChange?.(value)} /></div> : null}
      {supportsReverse ? <div className="flex items-center justify-between"><span className="text-[11px] text-cs2-text-secondary">反向播放</span><Toggle checked={Boolean(reverse)} onChange={(value) => onReverseChange?.(value)} /></div> : null}
    </PaneSection>

    {supportsSpeedRamp ? <PaneSection title="分段变速">
      <div className="grid grid-cols-2 gap-1.5">
        {[{ id: "off", label: "固定速度" }, ...SPEED_RAMP_PRESETS].map((preset) => <button key={preset.id} type="button" onClick={() => applyDiscreteSpeedEdit(() => preset.id === "off" ? onSpeedKeyframesChange?.([]) : setRamp(preset.id))} className={`rounded-md border px-2 py-1.5 text-[10px] font-semibold transition-colors ${(preset.id === "off" && !hasSpeedRamp) || preset.id === activeRampPresetId ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/50 text-cs2-text-muted hover:border-cs2-border-focus"}`}>{preset.label}</button>)}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-muted">{hasSpeedRamp ? "每个色块代表一段素材；同一色块内保持固定倍速，到分界点后切换下一段速度。" : "选择一个预设即可创建分段变速；它是分段切换，不是平滑曲线。"}</p>
      {hasSpeedRamp ? <div className="mt-3 space-y-2 border-t border-cs2-border/40 pt-2">
        <div className="flex items-center justify-between"><span className="text-[10px] font-semibold text-cs2-text-secondary">{activeRampPresetId ? SPEED_RAMP_PRESETS.find((preset) => preset.id === activeRampPresetId)?.label : "自定义分段"}</span><span className="text-[9px] text-cs2-text-muted">横向长度 = 素材占比</span></div>
        <div className="flex h-14 overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-input">
          {rampSegments.map((segment) => <div key={`segment-${segment.index}`} className={`flex min-w-0 flex-col items-center justify-center border-r border-cs2-bg-card px-1 last:border-r-0 ${segment.index % 2 ? "bg-cs2-accent/30" : "bg-cs2-accent/[0.16]"}`} style={{ width: `${segment.width}%` }} title={`素材 ${segment.from.toFixed(0)}%–${segment.to.toFixed(0)}% · ${segment.speed.toFixed(2)}x`}><span className="font-mono text-[11px] font-bold text-cs2-accent">{segment.speed.toFixed(2)}x</span><span className="max-w-full whitespace-normal text-center text-[8px] leading-tight text-cs2-text-muted">{segment.from.toFixed(0)}–{segment.to.toFixed(0)}%</span></div>)}
        </div>
        {rampPoints.slice(0, -1).map((point, index) => <ProSlider key={`ramp-speed-${index}`} label={`第 ${index + 1} 段速度 · ${rampSegments[index]?.from.toFixed(0) ?? 0}–${rampSegments[index]?.to.toFixed(0) ?? 100}% 素材`} value={Math.round((Number(point.speed) || VISUAL_SPEED_DEFAULT) * 100)} onChange={(value) => updateRampPoint(index, { speed: Math.max(VISUAL_SPEED_MIN, Math.min(VISUAL_SPEED_MAX, Number(value) / 100 || VISUAL_SPEED_DEFAULT)) })} min={speedMinPct} max={speedMaxPct} resetValue={VISUAL_SPEED_DEFAULT * 100} />)}
        {rampPoints.slice(1, -1).map((point, offset) => {
          const index = offset + 1;
          const previous = Number(rampPoints[index - 1]?.source_sec) || 0;
          const next = Number(rampPoints[index + 1]?.source_sec) || previous + 0.02;
          const percent = baseDur > 0 ? ((Number(point.source_sec) - (Number(trimIn) || 0)) / baseDur) * 100 : 50;
          return <ProSlider key={`ramp-anchor-${index}`} label={`分界点 ${offset + 1} · 素材位置 (%)`} value={Math.round(percent)} onChange={(value) => {
            const wanted = (Number(trimIn) || 0) + baseDur * Math.max(0, Math.min(1, Number(value) / 100 || 0));
            updateRampPoint(index, { source_sec: Math.max(previous + 0.01, Math.min(next - 0.01, wanted)) });
          }} min={5} max={95} resetValue={50} />;
        })}
      </div> : null}
    </PaneSection> : null}

    <PaneSection title="时长变化">
      <dl className="grid grid-cols-2 gap-2 text-[11px]"><dt className="text-cs2-text-muted">原始时长</dt><dd className="font-mono text-cs2-text-secondary">{baseDur ? `${baseDur.toFixed(1)}s` : "-"}</dd><dt className="text-cs2-text-muted">调速后</dt><dd className="font-mono font-semibold text-cs2-accent">{effectiveDur ? `${effectiveDur.toFixed(1)}s` : "-"}</dd></dl>
      <p className="text-[10px] leading-relaxed text-cs2-text-muted">速度、音调和反向仅作用于选中片段；导出时 FFmpeg 会通过 setpts / atempo / asetrate / reverse 处理。</p>
    </PaneSection>
    {!isAudioClip && supportsFreeze ? <PaneSection title="末帧定格"><ProSlider label="定格时长 (s)" value={safeFreeze} onChange={(value) => onFreezeFrameChange?.(Math.max(VISUAL_FREEZE_MIN_SEC, Math.min(VISUAL_FREEZE_MAX_SEC, Number(value) || VISUAL_FREEZE_DEFAULT_SEC)))} min={VISUAL_FREEZE_MIN_SEC} max={VISUAL_FREEZE_MAX_SEC} step={0.1} resetValue={VISUAL_FREEZE_DEFAULT_SEC} /></PaneSection> : null}
  </>;
}
