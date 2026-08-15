import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import API from "../../api/api";
import { desktopBridge } from "../../desktop/desktopBridge.js";

export function SectionCard({ title, hint, children, search, className, contentClassName }) {
  if (search) return null;
  return (
    <div className={`rounded-xl border border-cs2-border/70 bg-cs2-bg-card px-4 py-3.5 ${className ?? ""}`}>
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-cs2-text-secondary">{title}</h2>
        {hint && <span className="text-xs text-cs2-text-muted">{hint}</span>}
      </div>
      <div className={contentClassName ?? "divide-y divide-cs2-border/40"}>
        {children}
      </div>
    </div>
  );
}

export function SectionHeader({ title, hint, search, sectionId }) {
  if (search) return null;
  return (
    <div id={sectionId} className="mt-5 first:mt-1">
      <h2 className="text-sm font-bold uppercase tracking-wide text-cs2-text-secondary">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-cs2-text-muted">{hint}</p>}
      <div className="mt-1.5 border-b border-cs2-border/50" />
    </div>
  );
}

export function FieldRow({ label, hint, children, search }) {
  if (search) return null;
  return (
    <div className="py-2.5">
      <label className="block text-xs font-semibold text-cs2-text-secondary">{label}</label>
      {hint && <p className="mb-1 text-xs text-cs2-text-muted">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, type, className }) {
  return (
    <input
      type={type ?? "text"}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none ${className ?? ""}`}
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
      className={`w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-mono text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none resize-y ${className ?? ""}`}
    />
  );
}

export function NumberInput({ value, onChange, min, max, step, className }) {
  return (
    <input
      type="number"
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? "" : Number(v));
      }}
      min={min}
      max={max}
      step={step ?? 1}
      className={`w-32 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary focus-visible:border-cs2-accent focus-visible:outline-none ${className ?? ""}`}
    />
  );
}

export function SelectInput({ value, onChange, options, className }) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary focus-visible:border-cs2-accent focus-visible:outline-none ${className ?? ""}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ value, onChange, onLabel, offLabel, ariaLabel }) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-label={ariaLabel ?? (value ? (onLabel ?? "On") : (offLabel ?? "Off"))}
        aria-pressed={value}
        className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
          value ? "bg-cs2-accent" : "bg-cs2-bg-input"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-cs2-text-on-accent shadow transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      <span className="text-[11px] text-cs2-text-muted">{value ? (onLabel ?? "On") : (offLabel ?? "Off")}</span>
    </div>
  );
}

export function PathPicker({ value, onChange, placeholder, exeName, detectApi, detectField, t }) {
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
    <div className="flex gap-2">
      <input
        type="text"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none"
      />
      <button
        type="button"
        onClick={handleBrowse}
        disabled={detecting}
        className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent disabled:opacity-50"
      >
        {detecting ? <Loader2 className="h-3 w-3 animate-spin" /> : t("settings.browseBtn")}
      </button>
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

export function TagList({ items, onChange, placeholder, addLabel, emptyLabel }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) { setDraft(""); return; }
    onChange([...items, v]);
    setDraft("");
  };
  const remove = (idx) => onChange(items.filter((_, i) => i !== idx));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 && <span className="text-[11px] text-cs2-text-muted">{emptyLabel}</span>}
        {items.map((name, idx) => (
          <span key={`${name}-${idx}`} className="inline-flex items-center gap-1 rounded-md bg-cs2-bg-input px-2 py-1 text-[11px] text-cs2-text-primary">
            {name}
            <button type="button" onClick={() => remove(idx)} className="ml-0.5 text-cs2-text-muted hover:text-red-400">×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className="flex-1 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:border-cs2-accent focus-visible:outline-none"
        />
        <button type="button" onClick={add} className="shrink-0 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-xs font-medium text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-accent">
          {addLabel}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Static dropdown options
 * ------------------------------------------------------------------------ */

// 格式化上次检查时间（ISO 8601 UTC -> 本地友好显示）
