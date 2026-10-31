import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import API from "../../api/api";
import { desktopBridge } from "../../desktop/desktopBridge.js";

/* ---------------------------------------------------------------------------
 * 设置页统一控件：分组卡片 + 设置行 + 一类选项只用一种控件。
 * 开关类用 Switch，2–4 个互斥项用 Segmented，更多选项用 SelectInput。
 * ------------------------------------------------------------------------ */

export const SETTINGS_INPUT_CLASS =
  "h-8 min-w-0 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted outline-none transition-colors focus:border-cs2-accent disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANTS = {
  primary: "border border-cs2-accent bg-cs2-accent font-semibold text-black hover:brightness-110",
  secondary: "border border-cs2-border bg-cs2-bg-input font-medium text-cs2-text-secondary hover:border-cs2-text-muted hover:text-cs2-text-primary",
  ghost: "border border-transparent font-medium text-cs2-accent hover:bg-cs2-bg-hover",
  danger: "border border-cs2-border bg-cs2-bg-input font-medium text-cs2-text-secondary hover:border-cs2-border-error hover:text-cs2-text-error",
};

export function SettingsButton({ variant = "secondary", icon: Icon, busy = false, iconOnly = false, className = "", children, ...rest }) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 disabled:cursor-not-allowed disabled:opacity-45 ${iconOnly ? "w-8" : variant === "ghost" ? "px-2" : "px-3"} ${BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.secondary} ${className}`}
      {...rest}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function SettingsPageHeader({ title, description, actions }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-cs2-text-primary">{title}</h1>
        {description ? <p className="mt-1 text-[13px] text-cs2-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SettingsGroup({
  id,
  title,
  description,
  badge,
  actions,
  children,
  search,
  padded = false,
  className = "",
  bodyClassName,
  testId,
}) {
  if (search) return null;
  return (
    <section id={id} data-testid={testId} className={`mt-7 scroll-mt-4 first:mt-0 ${className}`}>
      {title || actions ? (
        <div className="mb-2.5 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-cs2-text-primary">
                {title}
                {badge}
              </h2>
            ) : null}
            {description ? <p className="mt-0.5 text-xs text-cs2-text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div
        className={
          bodyClassName
          ?? `overflow-hidden rounded-[10px] border border-cs2-border-subtle bg-cs2-bg-card ${padded ? "p-4" : "divide-y divide-cs2-border-subtle"}`
        }
      >
        {children}
      </div>
    </section>
  );
}

/**
 * 一行一个设置：左侧标题 + 一行说明，右侧控件。
 * stacked 用于路径、列表等需要整行宽度的控件；aside 放在标题行右侧（如占用空间）。
 */
export function SettingsRow({
  label,
  description,
  tooltip,
  children,
  aside,
  indent = false,
  disabled = false,
  stacked = false,
  footer,
  search,
  testId,
  labelId,
}) {
  if (search) return null;
  const dim = disabled ? "opacity-45" : "";
  const head = (
    <div className={`min-w-0 ${dim}`} title={tooltip}>
      {label ? (
        <div id={labelId} className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-cs2-text-primary">{label}</div>
      ) : null}
      {description ? <div className="mt-0.5 text-xs leading-relaxed text-cs2-text-muted">{description}</div> : null}
    </div>
  );
  return (
    <div
      data-testid={testId}
      className={`grid min-h-[52px] grid-cols-1 items-center gap-x-6 gap-y-2 py-3 pr-4 sm:grid-cols-[minmax(0,1fr)_auto] ${indent ? "pl-10" : "pl-4"}`}
    >
      {label || description ? head : null}
      {stacked ? (
        <>
          {aside ? <div className={`flex flex-wrap items-center gap-2 sm:justify-end ${dim}`}>{aside}</div> : null}
          <div className={`flex min-w-0 flex-wrap items-center gap-2 sm:col-span-2 ${dim}`}>{children}</div>
        </>
      ) : (
        <div className={`flex min-w-0 flex-wrap items-center gap-2 sm:justify-end ${dim}`}>
          {aside}
          {children}
        </div>
      )}
      {footer ? <div className={`min-w-0 sm:col-span-2 ${dim}`}>{footer}</div> : null}
    </div>
  );
}

export function SettingsSubhead({ children, search }) {
  if (search) return null;
  return (
    <div className="bg-cs2-bg-input/40 px-4 py-2 text-[11px] font-semibold tracking-wide text-cs2-text-muted">
      {children}
    </div>
  );
}

const NOTE_TONES = {
  amber: "bg-cs2-amber-surface text-cs2-amber-on-surface",
  rose: "bg-cs2-rose-surface text-cs2-rose-on-surface",
  emerald: "bg-cs2-emerald-surface text-cs2-emerald-on-surface",
  neutral: "bg-cs2-bg-input/40 text-cs2-text-secondary",
};

export function SettingsNote({ tone = "neutral", icon: Icon, children, testId, role }) {
  return (
    <div data-testid={testId} role={role} className={`flex items-start gap-2.5 px-4 py-3 text-xs leading-relaxed ${NOTE_TONES[tone] ?? NOTE_TONES.neutral}`}>
      {Icon ? <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function StatusText({ tone = "neutral", children }) {
  const color = tone === "ok"
    ? "text-cs2-emerald-on-surface"
    : tone === "warn"
      ? "text-cs2-amber-on-surface"
      : tone === "error"
        ? "text-cs2-rose-on-surface"
        : "text-cs2-text-muted";
  const dot = tone === "ok"
    ? "bg-cs2-emerald-on-surface"
    : tone === "warn"
      ? "bg-cs2-amber-on-surface"
      : tone === "error"
        ? "bg-cs2-rose-on-surface"
        : "bg-cs2-text-muted";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${color}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      {children}
    </span>
  );
}

export function SettingsBadge({ tone = "neutral", children }) {
  const tones = {
    amber: "bg-cs2-amber-surface text-cs2-amber-on-surface",
    accent: "bg-cs2-accent-soft text-cs2-accent",
    emerald: "bg-cs2-emerald-surface text-cs2-emerald-on-surface",
    rose: "bg-cs2-rose-surface text-cs2-rose-on-surface",
    cyan: "bg-cs2-cyan-surface text-cs2-cyan-on-surface",
    neutral: "border border-cs2-border-subtle bg-cs2-bg-input text-cs2-text-secondary",
  };
  return (
    <span className={`inline-flex h-[18px] items-center whitespace-nowrap rounded px-1.5 text-[10.5px] font-semibold ${tones[tone] ?? tones.neutral}`}>
      {children}
    </span>
  );
}

export function SizeLabel({ children }) {
  return <span className="whitespace-nowrap font-mono text-[11px] text-cs2-text-secondary">{children}</span>;
}

/* ─── Inputs ─────────────────────────────────────────────────────────── */

export function Switch({ checked, onChange, ariaLabel, disabled = false, testId }) {
  const on = !!checked;
  return (
    <label className={`relative inline-flex shrink-0 items-center py-3 -my-3 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        role="switch"
        data-testid={testId}
        aria-label={ariaLabel}
        checked={on}
        disabled={disabled}
        onChange={(event) => {
          if (!disabled) onChange?.(event.target.checked);
        }}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={`relative h-5 w-9 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-cs2-accent/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-cs2-bg-card ${
          on ? "bg-cs2-accent" : "bg-cs2-border"
        } ${disabled ? "opacity-50" : ""}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0"}`}
        />
      </span>
    </label>
  );
}

/** 2–4 个互斥选项。内部使用原生 radio，键盘方向键与读屏行为保持一致。 */
export function Segmented({ value, onChange, options, ariaLabel, disabled = false, name }) {
  const autoName = useId();
  const groupName = name ?? autoName;
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex max-w-full flex-wrap gap-0.5 rounded-[7px] border border-cs2-border-subtle bg-cs2-bg-input p-0.5 ${disabled ? "opacity-50" : ""}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        const optionDisabled = disabled || option.disabled;
        return (
          <label
            key={String(option.value)}
            title={option.title}
            className={`relative inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-[5px] px-3 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-cs2-accent/60 ${
              active
                ? "bg-cs2-bg-elevated font-semibold text-cs2-text-primary shadow-sm"
                : optionDisabled
                  ? "text-cs2-text-muted"
                  : "text-cs2-text-secondary hover:text-cs2-text-primary"
            } ${optionDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}
          >
            <input
              type="radio"
              name={groupName}
              value={String(option.value)}
              checked={active}
              disabled={optionDisabled}
              onChange={() => {
                if (!optionDisabled) onChange?.(option.value);
              }}
              className="sr-only"
            />
            {option.icon ? <option.icon className="h-3.5 w-3.5" aria-hidden /> : null}
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

export function SelectInput({ value, onChange, options, className = "", ariaLabel, disabled = false, children, testId }) {
  return (
    <span className={`relative inline-flex min-w-0 ${className || "w-60 max-w-full"}`}>
      <select
        aria-label={ariaLabel}
        data-testid={testId}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${SETTINGS_INPUT_CLASS} w-full cursor-pointer appearance-none pr-8`}
      >
        {children ?? options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" aria-hidden />
    </span>
  );
}

export function TextInput({ value, onChange, placeholder, type, className, ariaLabel, disabled, mono = false, readOnly }) {
  return (
    <input
      type={type ?? "text"}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      readOnly={readOnly}
      spellCheck={false}
      className={`${SETTINGS_INPUT_CLASS} ${mono ? "font-mono text-[11.5px]" : ""} ${readOnly ? "text-cs2-text-muted" : ""} ${className ?? "w-full"}`}
    />
  );
}

export function TextArea({ value, onChange, placeholder, rows, className }) {
  return (
    <textarea
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows ?? 3}
      className={`w-full resize-y rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-2 font-mono text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus:border-cs2-accent focus:outline-none ${className ?? ""}`}
    />
  );
}

/**
 * 数值输入：允许暂时清空；空值失焦恢复 defaultValue，onChange 只返回有限数值。
 * clampOnBlur 保留超出范围的编辑草稿，失焦时再限制范围。
 */
export function NumberInput({
  value,
  defaultValue,
  onChange,
  min,
  max,
  step,
  unit,
  ariaLabel,
  disabled = false,
  invalid = false,
  clampOnBlur = false,
  readOnly,
  list,
  className = "",
  inputClassName = "w-14 text-right",
}) {
  const [draft, setDraft] = useState(null);
  useEffect(() => setDraft(null), [value]);

  return (
    <span
      className={`inline-flex h-8 items-center rounded-md border bg-cs2-bg-input pr-2.5 transition-colors focus-within:border-cs2-accent ${
        invalid ? "border-cs2-border-error" : "border-cs2-border"
      } ${disabled ? "opacity-50" : ""} ${className}`}
    >
      <input
        type="number"
        value={draft ?? value ?? ""}
        min={min}
        max={max}
        step={step ?? 1}
        list={list}
        readOnly={readOnly}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          const n = Number(v);
          if (v === "" || (clampOnBlur && (n < min || n > max))) {
            setDraft(v);
            return;
          }
          setDraft(null);
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={(e) => {
          if (disabled || readOnly) return;
          const v = e.target.value;
          if (v !== "" && (!clampOnBlur || (Number(v) >= (min ?? -Infinity) && Number(v) <= (max ?? Infinity)))) return;
          const fallback = [v, defaultValue, value, min, 0].find(
            (v) => v != null && v !== "" && Number.isFinite(Number(v)),
          );
          const restored = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number(fallback)));
          setDraft(null);
          onChange(restored);
        }}
        className={`${inputClassName} min-w-0 bg-transparent py-0 pl-2.5 pr-1.5 font-mono text-xs text-cs2-text-primary outline-none disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
      />
      {unit ? <span className="whitespace-nowrap text-[11px] text-cs2-text-muted">{unit}</span> : null}
    </span>
  );
}

/** 有明确范围的连续数值：滑块与数值框联动。 */
export function RangeField({ value, defaultValue, onChange, min, max, step, unit, ariaLabel, disabled = false }) {
  const clamp = (n) => Math.min(Number(max), Math.max(Number(min), n));
  const range = Math.max(Number(max) - Number(min), 0);
  const progress = range > 0
    ? Math.min(100, Math.max(0, ((Number(value) - Number(min)) / range) * 100))
    : 0;
  return (
    <span className="inline-flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(Number(value)) ? value : min}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(clamp(parseFloat(e.target.value)))}
        className="cs2-data-slider w-40 disabled:cursor-not-allowed disabled:opacity-40"
        style={{ "--cs2-range-progress": `${progress}%`, "--cs2-range-accent": "var(--cs2-accent)" }}
      />
      <NumberInput
        value={value}
        defaultValue={defaultValue}
        clampOnBlur
        min={min}
        max={max}
        step={step}
        unit={unit}
        disabled={disabled}
        ariaLabel={ariaLabel}
        onChange={(n) => {
          if (typeof n === "number" && Number.isFinite(n)) onChange(clamp(n));
        }}
      />
    </span>
  );
}

export function PathPicker({ value, onChange, placeholder, exeName, detectApi, detectField, t, ariaLabel }) {
  const fileRef = useRef();
  const [detecting, setDetecting] = useState(false);

  const handleBrowse = async () => {
    // 如果没有值，先尝试自动检测
    if (!value || !value.trim()) {
      if (detectApi) {
        setDetecting(true);
        try {
          const { data } = await API.post(detectApi);
          const detectedPath = data[detectField];
          if (detectedPath) {
            onChange(detectedPath);
            return;
          }
        } catch {
          // 检测失败，继续打开文件选择对话框
        } finally {
          setDetecting(false);
        }
      }
    }

    // 后端原生文件选择（Windows；浏览器开发模式也可返回完整路径）
    try {
      const { data } = await API.post("file-picker", { file_type: "exe" });
      if (data?.path) {
        onChange(data.path);
        return;
      }
    } catch {
      // 非 Windows 或选择器不可用，继续 fallback
    }

    // 桌面壳文件选择对话框
    if (desktopBridge) {
      try {
        const defaultPath = value && value.trim() ? value : undefined;
        const result = await desktopBridge.showOpenDialog({
          title: t("settings.browseFileTitle"),
          defaultPath,
          filters: [{ name: exeName, extensions: ["exe"] }],
          properties: ["openFile"],
        });
        if (!result.canceled && result.filePaths?.[0]) {
          onChange(result.filePaths[0]);
        }
        return;
      } catch (e) {
        console.error("Desktop dialog error:", e);
      }
    }

    // 最后兜底：HTML file input（浏览器中通常只能拿到文件名）
    fileRef.current?.click();
  };

  return (
    <div className="flex w-full min-w-0 gap-2">
      <TextInput
        value={value ?? ""}
        onChange={onChange}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        mono
        className="flex-1"
      />
      <SettingsButton onClick={handleBrowse} disabled={detecting} busy={detecting}>
        {t("settings.browseBtn")}
      </SettingsButton>
      {/* 浏览器环境的最后兜底 */}
      <input
        ref={fileRef}
        type="file"
        accept=".exe"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onChange(file.path ?? file.webkitRelativePath ?? file.name);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function Chip({ children, onRemove, removeLabel, mono = false, title }) {
  return (
    <span
      title={title}
      className={`inline-flex h-[26px] max-w-full items-center gap-0.5 rounded-[5px] border border-cs2-border-subtle bg-cs2-bg-input pl-2 text-cs2-text-primary ${onRemove ? "pr-0.5" : "pr-2"} ${mono ? "font-mono text-[11.5px]" : "text-xs"}`}
    >
      <span className="truncate">{children}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-cs2-text-muted hover:text-cs2-text-error"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

export function TagList({ items, onChange, placeholder, addLabel, emptyLabel, mono = false, removeLabel }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) { setDraft(""); return; }
    onChange([...items, v]);
    setDraft("");
  };
  const remove = (idx) => onChange(items.filter((_, i) => i !== idx));
  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 && <span className="text-xs text-cs2-text-muted">{emptyLabel}</span>}
        {items.map((name, idx) => (
          <Chip key={`${name}-${idx}`} mono={mono} onRemove={() => remove(idx)} removeLabel={removeLabel ? removeLabel(name) : `× ${name}`}>
            {name}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          spellCheck={false}
          className={`${SETTINGS_INPUT_CLASS} flex-1 ${mono ? "font-mono text-[11.5px]" : ""}`}
        />
        <SettingsButton onClick={add}>{addLabel}</SettingsButton>
      </div>
    </div>
  );
}

/* ─── Compatibility wrappers for older call sites ────────────────────── */

export function SectionCard({ title, hint, children, search, className, contentClassName }) {
  return (
    <SettingsGroup
      title={title}
      description={hint}
      search={search}
      className={className}
      padded={contentClassName !== undefined}
    >
      {children}
    </SettingsGroup>
  );
}

export function FieldRow({ label, hint, children, search }) {
  return (
    <SettingsRow label={label} description={hint} search={search} stacked>
      {children}
    </SettingsRow>
  );
}

export function Toggle({ value, onChange, ariaLabel, onLabel, offLabel }) {
  return (
    <span className="inline-flex items-center gap-2">
      {onLabel || offLabel ? (
        <span className="text-xs text-cs2-text-muted">{value ? (onLabel ?? "On") : (offLabel ?? "Off")}</span>
      ) : null}
      <Switch checked={value} onChange={onChange} ariaLabel={ariaLabel} />
    </span>
  );
}
