import { ArrowDown, ArrowUp, Eye, EyeOff, Film, Lock, Music2, Trash2, Type, Unlock, Volume2, VolumeX } from "lucide-react";

import { useT } from "../../../i18n/useT.js";

export default function TimelineTrackHeader({ row, width = 128, selected, onSelect, onToggleHidden, onToggleLocked, onToggleMuted, onRemove, onMoveUp, onMoveDown }) {
  const t = useT();
  const editable = row.type === "video" || row.type === "audio" || row.type === "overlay";
  const RowIcon = row.type === "audio" ? Music2 : row.type === "overlay" ? Type : Film;
  return <div data-timeline-track-header data-selected={selected ? "true" : "false"} className={`litecut-timeline-track-header sticky left-0 z-20 flex shrink-0 items-center overflow-hidden border-r border-cs2-border px-2 transition-colors ${selected ? "litecut-timeline-track-header--selected" : ""}`} style={{ width, height: row.height }} onPointerDown={(event) => { event.stopPropagation(); onSelect(); }}>
    {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-cs2-accent" /> : null}
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`litecut-timeline-track-icon flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? "litecut-timeline-track-icon--selected" : ""}`}><RowIcon className="h-3 w-3" /></span>
        <button type="button" onClick={onSelect} className="block min-w-0 flex-1 truncate text-left text-[10px] font-bold text-cs2-text-primary hover:text-cs2-accent">{row.label}</button>
      </div>
      {editable ? <div className="mt-1 flex items-center gap-0.5 text-cs2-text-secondary">
        <button type="button" title={t("liteCut.track.moveUp")} onPointerDown={(event) => event.stopPropagation()} onClick={onMoveUp} className="rounded p-0.5 hover:bg-cs2-bg-hover hover:text-cs2-text-primary"><ArrowUp className="h-3 w-3" /></button>
        <button type="button" title={t("liteCut.track.moveDown")} onPointerDown={(event) => event.stopPropagation()} onClick={onMoveDown} className="rounded p-0.5 hover:bg-cs2-bg-hover hover:text-cs2-text-primary"><ArrowDown className="h-3 w-3" /></button>
        <button type="button" title={t(row.hidden ? "liteCut.track.show" : "liteCut.track.hide")} onPointerDown={(event) => event.stopPropagation()} onClick={onToggleHidden} className="rounded p-0.5 hover:bg-cs2-bg-hover hover:text-cs2-text-primary">{row.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}</button>
        <button type="button" title={t(row.locked ? "liteCut.track.unlock" : "liteCut.track.lock")} onPointerDown={(event) => event.stopPropagation()} onClick={onToggleLocked} className="rounded p-0.5 hover:bg-cs2-bg-hover hover:text-cs2-text-primary">{row.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}</button>
        {row.type !== "overlay" ? <button type="button" title={t(row.muted ? "liteCut.track.unmute" : "liteCut.track.mute")} onPointerDown={(event) => event.stopPropagation()} onClick={onToggleMuted} className="rounded p-0.5 hover:bg-cs2-bg-hover hover:text-cs2-text-primary">{row.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}</button> : null}
        {row.removable ? <button type="button" title={t("liteCut.track.delete")} aria-label={t("liteCut.track.deleteNamed", { label: row.label })} onPointerDown={(event) => event.stopPropagation()} onClick={onRemove} className="rounded p-0.5 hover:bg-rose-500/15 hover:text-rose-300"><Trash2 className="h-3 w-3" /></button> : null}
      </div> : null}
    </div>
  </div>;
}
