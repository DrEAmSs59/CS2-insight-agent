import { useState } from "react";
import { ChevronDown, FlipHorizontal, FlipVertical, Link2, RotateCcw, Unlink2 } from "lucide-react";
import { useLiteCutTimelineStore } from "../state/timelineStore.js";
import { LITE_CUT_OUTPUT_DEFAULTS } from "../state/projectContract.js";
import { normalizeSceneTransform, SCENE_TRANSFORM_DEFAULTS, SCENE_TRANSFORM_LIMITS, sceneTransformPixels } from "../state/sceneTransform.js";

function finiteValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function NumberInput({ value, min, max, step, onChange, onFocus, onBlur, className = "" }) {
  return (
    <input
      type="number"
      value={Number.isFinite(Number(value)) ? Number(value) : ""}
      min={min}
      max={max}
      step={step}
      onFocus={onFocus}
      onBlur={onBlur}
      onChange={(event) => {
        if (event.target.value === "") return;
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange?.(next);
      }}
      className={`litecut-property-number ${className}`.trim()}
    />
  );
}

export function snapRotation(value) {
  const points = [-180, -120, -90, -60, -30, 0, 30, 60, 90, 120, 180];
  const normalized = Math.max(
    SCENE_TRANSFORM_LIMITS.rotation_min,
    Math.min(SCENE_TRANSFORM_LIMITS.rotation_max, Number(value) || 0),
  );
  const nearest = points.reduce((best, point) => Math.abs(point - normalized) < Math.abs(best - normalized) ? point : best, 0);
  return Math.abs(nearest - normalized) <= 3 ? nearest : normalized;
}

export function useTransformControls(transform, onChange, defaultSize = 1) {
  const [sizeLinked, setSizeLinked] = useState(true);
  const width = Math.max(SCENE_TRANSFORM_LIMITS.size_min, Number(transform?.width) || defaultSize);
  const height = Math.max(SCENE_TRANSFORM_LIMITS.size_min, Number(transform?.height) || defaultSize);
  return {
    sizeLinked,
    toggleSizeLinked: () => setSizeLinked((value) => !value),
    setWidthPercent: (value) => {
      const next = value / 100;
      onChange?.(sizeLinked ? { width: next, height: height * next / width } : { width: next });
    },
    setHeightPercent: (value) => {
      const next = value / 100;
      onChange?.(sizeLinked ? { height: next, width: width * next / height } : { height: next });
    },
    setRotation: (value) => onChange?.({ rotation: snapRotation(value) }),
  };
}

export function PaneSection({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="litecut-property-collapse overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="litecut-property-collapse-header flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center whitespace-normal break-words text-[11px] font-semibold leading-snug text-cs2-text-secondary">{title}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cs2-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <div hidden={!open} className="litecut-property-collapse-content space-y-2">{children}</div>
    </section>
  );
}

export function ProSlider({ label, value, onChange, min = -100, max = 100, resetValue = 0, step = 1 }) {
  const beginPropertyEdit = useLiteCutTimelineStore((state) => state.beginPropertyEdit);
  const endPropertyEdit = useLiteCutTimelineStore((state) => state.endPropertyEdit);
  const numericValue = Math.max(min, Math.min(max, finiteValue(value, resetValue)));
  const progress = max > min ? ((numericValue - min) / (max - min)) * 100 : 0;
  return (
    <div className="litecut-property-control-row group grid min-h-9 grid-cols-[minmax(64px,84px)_minmax(28px,1fr)_52px_24px] items-center gap-1 rounded-md px-1 py-1 transition-colors hover:bg-cs2-bg-hover/35">
      <span className="min-w-0 whitespace-normal break-words text-[10px] font-medium leading-[1.35] text-cs2-text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={numericValue}
        aria-label={label}
        style={{ "--cs2-range-progress": `${progress}%` }}
        onBlur={endPropertyEdit}
        onKeyDown={beginPropertyEdit}
        onKeyUp={endPropertyEdit}
        onPointerDown={beginPropertyEdit}
        onPointerUp={endPropertyEdit}
        onPointerCancel={endPropertyEdit}
        onChange={(event) => onChange(Number(event.target.value))}
        className="cs2-data-slider min-w-0 flex-1"
      />
      <NumberInput value={numericValue} min={min} max={max} step={step} onFocus={beginPropertyEdit} onBlur={endPropertyEdit} onChange={onChange} className="w-full min-w-0" />
      <button type="button" disabled={numericValue === resetValue} onClick={() => { beginPropertyEdit(); onChange(resetValue); endPropertyEdit(); }} className="inline-flex h-7 w-6 items-center justify-center rounded-md text-cs2-text-muted transition-colors hover:bg-cs2-accent-soft hover:text-cs2-accent disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-cs2-text-muted" title="重置" aria-label={`${label}重置`}>
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ScopeActionButton({ children, icon: Icon, disabled, onClick }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-cs2-border/70 bg-cs2-bg-input px-2.5 text-[10px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/45 hover:bg-cs2-accent-soft hover:text-cs2-accent disabled:cursor-not-allowed disabled:opacity-40"><Icon className="h-3.5 w-3.5" />{children}</button>;
}

export function NumericPairCard({ title, firstLabel, firstValue, onFirstChange, secondLabel, secondValue, onSecondChange, min = 0, max = 100, step = 1, linked, onToggleLinked }) {
  return (
    <div className="group flex min-h-9 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-cs2-bg-hover/35">
      <p className="w-[44px] shrink-0 text-[10px] font-medium text-cs2-text-muted">{title}</p>
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
        <label className="flex items-center gap-1 text-[10px] text-cs2-text-muted"><span>{firstLabel}</span><NumberInput min={min} max={max} step={step} value={firstValue} onChange={onFirstChange} className="min-w-0 flex-1" /></label>
        <label className="flex items-center gap-1 text-[10px] text-cs2-text-muted"><span>{secondLabel}</span><NumberInput min={min} max={max} step={step} value={secondValue} onChange={onSecondChange} className="min-w-0 flex-1" /></label>
      </div>
      {onToggleLinked ? <button type="button" aria-label={linked ? "解锁宽高比例" : "锁定宽高比例"} title={linked ? "解锁宽高比例" : "锁定宽高比例"} onClick={onToggleLinked} className={`inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-cs2-accent-soft hover:text-cs2-accent ${linked ? "text-cs2-accent" : "text-cs2-text-muted"}`}>{linked ? <Link2 className="h-3.5 w-3.5" /> : <Unlink2 className="h-3.5 w-3.5" />}</button> : <span className="w-6 shrink-0" />}
    </div>
  );
}

export function SceneTransformControls({
  transform,
  onChange,
  outputWidth = LITE_CUT_OUTPUT_DEFAULTS.width,
  outputHeight = LITE_CUT_OUTPUT_DEFAULTS.height,
  flipHorizontal = false,
  flipVertical = false,
  onFlipHorizontal,
  onFlipVertical,
}) {
  const normalized = normalizeSceneTransform(transform);
  const pixels = sceneTransformPixels(normalized, outputWidth, outputHeight);
  const controls = useTransformControls(normalized, onChange, normalized.width);
  const canvasWidth = Math.max(1, Number(outputWidth) || LITE_CUT_OUTPUT_DEFAULTS.width);
  const canvasHeight = Math.max(1, Number(outputHeight) || LITE_CUT_OUTPUT_DEFAULTS.height);
  const positionPixelLimit = Math.max(canvasWidth, canvasHeight)
    * Math.max(Math.abs(SCENE_TRANSFORM_LIMITS.position_min), Math.abs(SCENE_TRANSFORM_LIMITS.position_max));
  const renderedPixelLimit = Math.max(canvasWidth, canvasHeight)
    * SCENE_TRANSFORM_LIMITS.size_max
    * SCENE_TRANSFORM_LIMITS.scale_max;
  const renderedPixelMinimum = Math.min(canvasWidth, canvasHeight)
    * SCENE_TRANSFORM_LIMITS.size_min
    * SCENE_TRANSFORM_LIMITS.scale_min;
  const setWidthPx = (value) => {
    const width = Math.max(SCENE_TRANSFORM_LIMITS.size_min, Math.min(
      SCENE_TRANSFORM_LIMITS.size_max,
      finiteValue(value, renderedPixelMinimum) / (canvasWidth * normalized.scale),
    ));
    onChange?.(controls.sizeLinked
      ? { width, height: normalized.height * width / normalized.width }
      : { width });
  };
  const setHeightPx = (value) => {
    const height = Math.max(SCENE_TRANSFORM_LIMITS.size_min, Math.min(
      SCENE_TRANSFORM_LIMITS.size_max,
      finiteValue(value, renderedPixelMinimum) / (canvasHeight * normalized.scale),
    ));
    onChange?.(controls.sizeLinked
      ? { height, width: normalized.width * height / normalized.height }
      : { height });
  };
  return (
    <>
      <div className="grid grid-cols-1 gap-1">
        <NumericPairCard
          title="位置(px)"
          firstLabel="X"
          firstValue={Number(pixels.x.toFixed(3))}
          onFirstChange={(value) => onChange?.({ x: value / canvasWidth })}
          secondLabel="Y"
          secondValue={Number(pixels.y.toFixed(3))}
          onSecondChange={(value) => onChange?.({ y: value / canvasHeight })}
          min={-positionPixelLimit}
          max={positionPixelLimit}
          step={0.001}
        />
        <NumericPairCard
          title="实际(px)"
          firstLabel="W"
          firstValue={Number(pixels.renderedWidth.toFixed(3))}
          onFirstChange={setWidthPx}
          secondLabel="H"
          secondValue={Number(pixels.renderedHeight.toFixed(3))}
          onSecondChange={setHeightPx}
          min={renderedPixelMinimum}
          max={renderedPixelLimit}
          step={0.001}
          linked={controls.sizeLinked}
          onToggleLinked={controls.toggleSizeLinked}
        />
      </div>
      <ProSlider label="整体缩放 %" value={normalized.scale * 100} onChange={(value) => onChange?.({ scale: value / 100 })} min={SCENE_TRANSFORM_LIMITS.scale_min * 100} max={SCENE_TRANSFORM_LIMITS.scale_max * 100} resetValue={SCENE_TRANSFORM_DEFAULTS.scale * 100} step={0.1} />
      <ProSlider label="旋转 °" value={normalized.rotation} onChange={controls.setRotation} min={SCENE_TRANSFORM_LIMITS.rotation_min} max={SCENE_TRANSFORM_LIMITS.rotation_max} resetValue={SCENE_TRANSFORM_DEFAULTS.rotation} step={0.1} />
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" onClick={() => onFlipHorizontal?.(!flipHorizontal)} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-[10px] font-semibold ${flipHorizontal ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted"}`}><FlipHorizontal className="h-4 w-4" />左右镜像</button>
        <button type="button" onClick={() => onFlipVertical?.(!flipVertical)} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-[10px] font-semibold ${flipVertical ? "border-cs2-accent/70 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border/60 text-cs2-text-muted"}`}><FlipVertical className="h-4 w-4" />上下镜像</button>
      </div>
      <ProSlider label="透明度 %" value={normalized.opacity * 100} onChange={(value) => onChange?.({ opacity: value / 100 })} min={SCENE_TRANSFORM_LIMITS.opacity_min * 100} max={SCENE_TRANSFORM_LIMITS.opacity_max * 100} resetValue={SCENE_TRANSFORM_DEFAULTS.opacity * 100} step={0.1} />
    </>
  );
}

export function Toggle({ checked, onChange }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-cs2-accent" : "bg-cs2-bg-input"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "left-[18px]" : "left-0.5"}`} /></button>;
}
