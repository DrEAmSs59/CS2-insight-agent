import { ArrowDown, ArrowUp, Eye, EyeOff, Film, Lock, Music2, Trash2, Type, Unlock, Volume2, VolumeX } from "lucide-react";

export default function TimelineTrackHeader({ row, width = 128, selected, onSelect, onToggleHidden, onToggleLocked, onToggleMuted, onRemove, onMoveUp, onMoveDown }) {
  const editable = row.type === "video" || row.type === "audio" || row.type === "overlay";
  const RowIcon = row.type === "audio" ? Music2 : row.type === "overlay" ? Type : Film;
  return <div data-timeline-track-header data-selected={selected ? "true" : "false"} className={`litecut-timeline-track-header sticky left-0 z-20 flex shrink-0 items-center border-r border-cs2-border px-2 transition-colors ${selected ? "litecut-timeline-track-header--selected" : ""}`} style={{ width, height: row.height }} onPointerDown={(event) => { event.stopPropagation(); onSelect(); }}>
    {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-cs2-accent" /> : null}
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? "border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-input text-cs2-text-muted"}`}><RowIcon className="h-3 w-3" /></span>
        <button type="button" onClick={onSelect} className="block min-w-0 flex-1 truncate text-left text-[10px] font-bold text-cs2-text-secondary hover:text-white">{row.label}</button>
      </div>
      {editable ? <div className="mt-1 flex items-center gap-0.5 pl-6 text-cs2-text-muted">
        <button type="button" title="轨道上移" onPointerDown={(event) => event.stopPropagation()} onClick={onMoveUp} className="rounded p-0.5 hover:bg-white/10 hover:text-white"><ArrowUp className="h-3 w-3" /></button>
        <button type="button" title="轨道下移" onPointerDown={(event) => event.stopPropagation()} onClick={onMoveDown} className="rounded p-0.5 hover:bg-white/10 hover:text-white"><ArrowDown className="h-3 w-3" /></button>
        <button type="button" title={row.hidden ? "显示轨道" : "隐藏轨道"} onPointerDown={(event) => event.stopPropagation()} onClick={onToggleHidden} className="rounded p-0.5 hover:bg-white/10 hover:text-white">{row.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}</button>
        <button type="button" title={row.locked ? "解锁轨道" : "锁定轨道"} onPointerDown={(event) => event.stopPropagation()} onClick={onToggleLocked} className="rounded p-0.5 hover:bg-white/10 hover:text-white">{row.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}</button>
        {row.type !== "overlay" ? <button type="button" title={row.muted ? "取消静音轨道" : "静音轨道"} onPointerDown={(event) => event.stopPropagation()} onClick={onToggleMuted} className="rounded p-0.5 hover:bg-white/10 hover:text-white">{row.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}</button> : null}
        {row.removable ? <button type="button" title="删除轨道" aria-label={`删除${row.label}`} onPointerDown={(event) => event.stopPropagation()} onClick={onRemove} className="rounded p-0.5 hover:bg-rose-500/15 hover:text-rose-300"><Trash2 className="h-3 w-3" /></button> : null}
      </div> : null}
    </div>
  </div>;
}
