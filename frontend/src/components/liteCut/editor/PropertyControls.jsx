import { useState } from "react";
import { ChevronDown, Link2, RotateCcw, Unlink2 } from "lucide-react";
import { Collapse, InputNumber, Slider } from "antd";
import { useLiteCutTimelineStore } from "../../../stores/liteCut/timelineStore.js";

export function snapRotation(value) {
  const points = [-180, -120, -90, -60, -30, 0, 30, 60, 90, 120, 180];
  const normalized = Math.max(-180, Math.min(180, Number(value) || 0));
  const nearest = points.reduce((best, point) => Math.abs(point - normalized) < Math.abs(best - normalized) ? point : best, 0);
  return Math.abs(nearest - normalized) <= 3 ? nearest : normalized;
}

export function useTransformControls(transform, onChange, defaultSize = 1) {
  const [sizeLinked, setSizeLinked] = useState(true);
  const width = Math.max(0.01, Number(transform?.width) || defaultSize);
  const height = Math.max(0.01, Number(transform?.height) || defaultSize);
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
  return (
    <Collapse
      ghost
      defaultActiveKey={defaultOpen ? ["content"] : []}
      expandIconPosition="end"
      expandIcon={({ isActive }) => (
        <ChevronDown className={`h-3.5 w-3.5 text-cs2-text-muted transition-transform ${isActive ? "rotate-180" : ""}`} />
      )}
      className="litecut-property-collapse overflow-hidden rounded-lg border border-cs2-border/55 bg-cs2-bg-card shadow-sm"
      items={[{
        key: "content",
        label: <span className="flex min-w-0 items-center whitespace-normal break-words text-[11px] font-semibold leading-snug text-cs2-text-secondary">{title}</span>,
        children: <div className="space-y-1">{children}</div>,
      }]}
    />
  );
}

export function ProSlider({ label, value, onChange, min = -100, max = 100, resetValue = 0, step = 1 }) {
  const beginPropertyEdit = useLiteCutTimelineStore((state) => state.beginPropertyEdit);
  const endPropertyEdit = useLiteCutTimelineStore((state) => state.endPropertyEdit);
  return (
    <div className="litecut-property-control-row group grid min-h-9 grid-cols-[minmax(64px,84px)_minmax(28px,1fr)_52px_24px] items-center gap-1 rounded-md px-1 py-1 transition-colors hover:bg-cs2-bg-hover/35">
      <span className="min-w-0 whitespace-normal break-words text-[10px] font-medium leading-[1.35] text-cs2-text-muted">{label}</span>
      <Slider min={min} max={max} step={step} value={value} onPointerDown={beginPropertyEdit} onPointerCancel={endPropertyEdit} onChange={(next) => onChange(Number(next))} onChangeComplete={endPropertyEdit} tooltip={{ open: false }} className="litecut-property-slider !m-0 min-w-0 flex-1" />
      <InputNumber value={value} min={min} max={max} step={step} onFocus={beginPropertyEdit} onBlur={endPropertyEdit} onChange={(next) => next !== null && onChange(Number(next))} controls={false} className="litecut-property-number !w-full min-w-0" />
      <button type="button" disabled={value === resetValue} onClick={() => { beginPropertyEdit(); onChange(resetValue); endPropertyEdit(); }} className="inline-flex h-7 w-6 items-center justify-center rounded-md text-cs2-text-muted transition-colors hover:bg-cs2-accent-soft hover:text-cs2-accent disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-cs2-text-muted" title="重置" aria-label={`${label}重置`}>
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ScopeActionButton({ children, icon: Icon, disabled, onClick }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-cs2-border/70 bg-cs2-bg-input px-2.5 text-[10px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/45 hover:bg-cs2-accent-soft hover:text-cs2-accent disabled:cursor-not-allowed disabled:opacity-40"><Icon className="h-3.5 w-3.5" />{children}</button>;
}

export function NumericPairCard({ title, firstLabel, firstValue, onFirstChange, secondLabel, secondValue, onSecondChange, min = 0, max = 100, linked, onToggleLinked }) {
  return (
    <div className="group flex min-h-9 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-cs2-bg-hover/35">
      <p className="w-[44px] shrink-0 text-[10px] font-medium text-cs2-text-muted">{title}</p>
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
        <label className="flex items-center gap-1 text-[10px] text-cs2-text-muted"><span>{firstLabel}</span><InputNumber controls={false} min={min} max={max} value={firstValue} onChange={(value) => value !== null && onFirstChange?.(Number(value))} className="litecut-property-number min-w-0 flex-1" /></label>
        <label className="flex items-center gap-1 text-[10px] text-cs2-text-muted"><span>{secondLabel}</span><InputNumber controls={false} min={min} max={max} value={secondValue} onChange={(value) => value !== null && onSecondChange?.(Number(value))} className="litecut-property-number min-w-0 flex-1" /></label>
      </div>
      {onToggleLinked ? <button type="button" aria-label={linked ? "解锁宽高比例" : "锁定宽高比例"} title={linked ? "解锁宽高比例" : "锁定宽高比例"} onClick={onToggleLinked} className={`inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-cs2-accent-soft hover:text-cs2-accent ${linked ? "text-cs2-accent" : "text-cs2-text-muted"}`}>{linked ? <Link2 className="h-3.5 w-3.5" /> : <Unlink2 className="h-3.5 w-3.5" />}</button> : <span className="w-6 shrink-0" />}
    </div>
  );
}

export function Toggle({ checked, onChange }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-cs2-accent" : "bg-cs2-bg-input"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "left-[18px]" : "left-0.5"}`} /></button>;
}
