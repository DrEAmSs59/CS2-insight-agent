/* Copyright (c) Ian Lucas. All rights reserved.
 * MIT License: /licenses/ianlucas-inventory-simulator.txt
 * Adapted from cs2-inventory-simulator at 1fd61a6320659f36dc4e66bd873c1402fb3c1c8b:
 * inventory-item-tile, inventory-filter, modal, modal-button, editor-label,
 * editor-input and editor-step-range-with-input. Insight supplies data/actions. */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Funnel } from "lucide-react";
import Button from "../../components/ui/Button.jsx";
import "./lucasWorkshop.css";
import LucasIcon from "./LucasIcon.jsx";

export function LucasButton({ children, className = "", variant = "primary", size, ...props }) {
  return <Button {...props} variant={variant === "apply" ? "primary" : variant} size={size} className={className}>{children}</Button>;
}

export function LucasItemTile({ label, model, finish, rarity, image, attachments, badge, children, onClick, menuOnClick = true, selected, previewProps, buttonProps }) {
  const [menu, setMenu] = useState(false);
  const root = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = event => { if (!root.current?.contains(event.target)) setMenu(false); };
    const escape = event => { if (event.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [menu]);
  return <article ref={root} className="lucas-tile" data-selected={selected || undefined} onContextMenu={children ? event => { event.preventDefault(); setMenu(true); } : undefined}>
    <button {...buttonProps} type="button" className="lucas-tile-open" onClick={children && menuOnClick ? () => setMenu(!menu) : onClick} aria-haspopup={children ? "menu" : undefined} aria-expanded={children ? menu : undefined} aria-label={label} aria-pressed={selected}>
      <span {...previewProps} className={`lucas-tile-image ${previewProps?.className || ""}`}>
        {image}
        {attachments && <span className="lucas-tile-attachments">{attachments}</span>}
        {badge && <span className="lucas-tile-badge">{badge}</span>}
      </span>
      <span className="lucas-tile-rarity" style={{ backgroundColor: rarity || "#b0c3d9" }} />
      <span className="lucas-tile-name">{model && <strong>{model}</strong>}{finish && <span>{finish}</span>}</span>
    </button>
    {children && <>
      {menu && <div className="lucas-tile-menu" role="menu" onClick={() => setMenu(false)}>{children}</div>}
    </>}
  </article>;
}

/** Category tabs plus a tools row: something on the left and an optional control on the right. */
export function LucasCategoryFilter({ locale, categories, category, onCategory, leading, trailing }) {
  const en = locale === "en";
  return <div className="lucas-inventory-filter">
    <div className="lucas-filter-tabs" role="group" aria-label={en ? "Item categories" : "饰品分类"}>
      {categories.map(([value, label]) =>
        <Button key={value} size="sm" variant={category === value ? "primary" : "ghost"} aria-pressed={category === value} onClick={() => onCategory(value)}>{label}</Button>)}
    </div>
    <div className="lucas-filter-tools">
      {leading}
      {trailing}
    </div>
  </div>;
}

/** Right-hand select of the tools row, marked as a filter (funnel) or a sort (arrows). */
export function LucasToolSelect({ kind = "filter", label, value, options, onChange }) {
  return <div className="lucas-sort">
    {kind === "sort" ? <LucasIcon name="arrow-down-wide-short"/> : <Funnel size={16} aria-hidden/>}
    <LucasSelect label={label} value={value} onChange={onChange} options={options}/>
  </div>;
}

export function LucasModal({ open, suspended = false, onClose, title, subtitle, headerRight, headerContent, children, footer, maxWidth = "max-w-[720px]", maxHeight = "max-h-[90vh]", contentClassName = "", zIndex = 115, fillHeight = false, className = "" }) {
  const titleId = useId(), root = useRef(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || suspended) return;
    const previous = document.activeElement;
    const panel = root.current;
    panel?.focus();
    const keydown = event => {
      if (event.key === "Escape") { event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(node => node.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first?.focus(); }
    };
    panel?.addEventListener("keydown", keydown);
    return () => { panel?.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, [open, suspended]);
  if (!open) return null;
  // Local 3D takes over the workspace without unmounting the editing draft.
  return createPortal(<div className="lucas-modal-backdrop" style={{ zIndex, display: suspended ? "none" : undefined }} inert={suspended || undefined} aria-hidden={suspended || undefined} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`lucas-modal ${className} ${maxWidth} ${maxHeight} ${fillHeight ? "h-full" : ""}`}>
      {headerContent ? <header id={titleId}>{headerContent}</header> : <div className="lucas-modal-header-wrap"><header className="lucas-modal-header"><h2 id={titleId}>{title}</h2>{headerRight}<button type="button" onClick={onClose} aria-label="关闭 / Close"><LucasIcon name="xmark"/></button></header></div>}
      {subtitle && <p className="lucas-modal-subtitle">{subtitle}</p>}
      <div className={`lucas-modal-content ${contentClassName}`}>{children}</div>
      {footer && <footer className="lucas-modal-footer">{footer}</footer>}
    </section>
  </div>, document.body);
}

export function LucasParameter({ label, value, onChange, min, max, step, error, randomLabel }) {
  const display = typeof value === "number" && step < 1 ? value.toFixed(6) : value;
  const slider = Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : min;
  return <div role="group" aria-label={label} className="lucas-parameter">
    <span className="lucas-editor-label" title={step < 1 ? `${min.toFixed(6)}–${max.toFixed(6)}` : `${min}–${max}`}>{label}</span>
    <input type="text" aria-label={label} inputMode={step < 1 ? "decimal" : "numeric"} value={display} aria-invalid={Boolean(error)} onChange={event => onChange(event.target.value)} />
    <input type="range" aria-label={`${label} slider`} min={min} max={max} step={step} value={slider} onChange={event => onChange(step < 1 ? Number(event.target.value).toFixed(6) : event.target.value)} />
    <button type="button" aria-label={`${randomLabel} · ${label}`} title={randomLabel} onClick={() => onChange(step < 1 ? (min + Math.random() * (max - min)).toFixed(6) : String(min + Math.floor(Math.random() * (max - min + 1))))}><LucasIcon name="shuffle" size={12}/></button>
    {error && <span role="alert" className="lucas-parameter-error">{error}</span>}
  </div>;
}

// Workshop selects use the same semantic surfaces and focus treatment as Insight inputs.
export function LucasSelect({label, value, options, onChange}) {
  const [open,setOpen]=useState(false), root=useRef(null);
  useEffect(()=>{if(!open)return;const dismiss=e=>{if(!root.current?.contains(e.target))setOpen(false);};const close=()=>setOpen(false);document.addEventListener("pointerdown",dismiss);window.addEventListener("blur",close);return()=>{document.removeEventListener("pointerdown",dismiss);window.removeEventListener("blur",close);};},[open]);
  return <div ref={root} className="lucas-select" onKeyDown={event=>{if(event.key==="Escape")setOpen(false);}}>
    <Button variant="secondary" aria-label={label} aria-expanded={open} aria-haspopup="listbox" onClick={()=>setOpen(!open)}><span>{options.find(option=>option.value===value)?.label || label}</span><LucasIcon name="caret-down"/></Button>
    {open && <div role="listbox" aria-label={label}>{options.map(option=><button type="button" key={option.value} role="option" aria-selected={value===option.value} onClick={()=>{onChange(option.value);setOpen(false);root.current.querySelector("button").focus();}}>{option.label}</button>)}</div>}
  </div>;
}
