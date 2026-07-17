import { useLiteCutTimelineStore } from "../../../stores/liteCut/timelineStore.js";
import { matchingSpeedRampPresetId, SPEED_RAMP_PRESETS, speedRampDisplaySegments, speedRampPointsForPreset } from "./speedRampUiUtils.js";
import { PaneSection, ProSlider, Toggle } from "./PropertyControls.jsx";

export default function SpeedPropertyPane({
  speed = 1,
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
  freezeFrameSec = 0,
  onFreezeFrameChange,
  isAudioClip = false,
}) {
  const beginPropertyEdit = useLiteCutTimelineStore((state) => state.beginPropertyEdit);
  const endPropertyEdit = useLiteCutTimelineStore((state) => state.endPropertyEdit);
  const speedPct = Math.round(Math.max(0.25, Math.min(4, Number(speed) || 1)) * 100);
  const baseDur = Number(sourceDuration) > 0 ? Number(sourceDuration) : 0;
  const safeFreeze = Math.max(0, Math.min(30, Number(freezeFrameSec) || 0));
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
    onSpeedChange?.(Math.max(25, Math.min(400, Number(pct) || 100)) / 100);
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
        <ProSlider label="整段速度 (%)" value={speedPct} onChange={setSpeedPct} min={25} max={400} resetValue={100} />
      </> : <div className="flex items-center justify-between gap-3 rounded-lg border border-cs2-accent/30 bg-cs2-accent-soft px-3 py-2">
        <div><p className="text-[11px] font-semibold text-cs2-accent">当前使用分段变速</p><p className="mt-0.5 text-[9px] text-cs2-text-muted">固定速度控件已隐藏，避免误操作清除分段。</p></div>
        <button type="button" onClick={() => applyDiscreteSpeedEdit(() => onSpeedKeyframesChange?.([]))} className="shrink-0 rounded-md border border-cs2-accent/40 px-2 py-1 text-[10px] font-semibold text-cs2-accent hover:bg-cs2-accent/10">切换为固定速度</button>
      </div>}
      <div className="flex items-center justify-between"><span className="text-[11px] text-cs2-text-secondary">保持音调</span><Toggle checked={Boolean(preservePitch)} onChange={(value) => onPreservePitchChange?.(value)} /></div>
      <div className="flex items-center justify-between"><span className="text-[11px] text-cs2-text-secondary">反向播放</span><Toggle checked={Boolean(reverse)} onChange={(value) => onReverseChange?.(value)} /></div>
    </PaneSection>

    <PaneSection title="分段变速">
      <div className="grid grid-cols-2 gap-1.5">
        {[{ id: "off", label: "固定速度" }, ...SPEED_RAMP_PRESETS].map((preset) => <button key={preset.id} type="button" onClick={() => applyDiscreteSpeedEdit(() => preset.id === "off" ? onSpeedKeyframesChange?.([]) : setRamp(preset.id))} className={`rounded-md border px-2 py-1.5 text-[10px] font-semibold transition-colors ${(preset.id === "off" && !hasSpeedRamp) || preset.id === activeRampPresetId ? "border-cs2-accent/60 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/50 text-cs2-text-muted hover:border-cs2-border-focus"}`}>{preset.label}</button>)}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-cs2-text-muted">{hasSpeedRamp ? "每个色块代表一段素材；同一色块内保持固定倍速，到分界点后切换下一段速度。" : "选择一个预设即可创建分段变速；它是分段切换，不是平滑曲线。"}</p>
      {hasSpeedRamp ? <div className="mt-3 space-y-2 border-t border-cs2-border/40 pt-2">
        <div className="flex items-center justify-between"><span className="text-[10px] font-semibold text-cs2-text-secondary">{activeRampPresetId ? SPEED_RAMP_PRESETS.find((preset) => preset.id === activeRampPresetId)?.label : "自定义分段"}</span><span className="text-[9px] text-cs2-text-muted">横向长度 = 素材占比</span></div>
        <div className="flex h-14 overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-input">
          {rampSegments.map((segment) => <div key={`segment-${segment.index}`} className={`flex min-w-0 flex-col items-center justify-center border-r border-cs2-bg-card px-1 last:border-r-0 ${segment.index % 2 ? "bg-cs2-accent/30" : "bg-cs2-accent/[0.16]"}`} style={{ width: `${segment.width}%` }} title={`素材 ${segment.from.toFixed(0)}%–${segment.to.toFixed(0)}% · ${segment.speed.toFixed(2)}x`}><span className="font-mono text-[11px] font-bold text-cs2-accent">{segment.speed.toFixed(2)}x</span><span className="max-w-full whitespace-normal text-center text-[8px] leading-tight text-cs2-text-muted">{segment.from.toFixed(0)}–{segment.to.toFixed(0)}%</span></div>)}
        </div>
        {rampPoints.slice(0, -1).map((point, index) => <ProSlider key={`ramp-speed-${index}`} label={`第 ${index + 1} 段速度 · ${rampSegments[index]?.from.toFixed(0) ?? 0}–${rampSegments[index]?.to.toFixed(0) ?? 100}% 素材`} value={Math.round((Number(point.speed) || 1) * 100)} onChange={(value) => updateRampPoint(index, { speed: Math.max(0.25, Math.min(4, Number(value) / 100 || 1)) })} min={25} max={400} resetValue={100} />)}
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
    </PaneSection>

    <PaneSection title="时长变化">
      <dl className="grid grid-cols-2 gap-2 text-[11px]"><dt className="text-cs2-text-muted">原始时长</dt><dd className="font-mono text-cs2-text-secondary">{baseDur ? `${baseDur.toFixed(1)}s` : "-"}</dd><dt className="text-cs2-text-muted">调速后</dt><dd className="font-mono font-semibold text-cs2-accent">{effectiveDur ? `${effectiveDur.toFixed(1)}s` : "-"}</dd></dl>
      <p className="text-[10px] leading-relaxed text-cs2-text-muted">速度、音调和反向仅作用于选中片段；导出时 FFmpeg 会通过 setpts / atempo / asetrate / reverse 处理。</p>
    </PaneSection>
    {!isAudioClip ? <PaneSection title="末帧定格"><ProSlider label="定格时长 (s)" value={safeFreeze} onChange={(value) => onFreezeFrameChange?.(Math.max(0, Math.min(30, Number(value) || 0)))} min={0} max={10} step={0.1} resetValue={0} /></PaneSection> : null}
  </>;
}
