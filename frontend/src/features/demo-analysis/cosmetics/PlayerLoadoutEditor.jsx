import { useMemo, useState } from "react";
import { Check, Music2, Search, UserRound } from "lucide-react";
import Modal from "../../../components/ui/Modal.jsx";
import { CS2_COSMETICS_ITEMS } from "../../../generated/cs2CosmeticsCatalog.js";

export function loadoutCandidates(field) {
  const rows = CS2_COSMETICS_ITEMS.filter(item => field === "music_kit"
    ? item.type === "musickit" && Number(item.index) > 0
    : item.type === "agent" && item.teams === (field === "agent_t" ? 0 : 1));
  return [...new Map(rows.map(item => [field === "music_kit" ? item.index : item.def, item])).values()];
}

export default function PlayerLoadoutEditor({ value, onChange, editable, locale, onlineAssetsEnabled }) {
  const [field, setField] = useState(null);
  const [query, setQuery] = useState("");
  const zh = String(locale).startsWith("zh");
  const labels = { agent_t: zh ? "T 探员" : "T agent", agent_ct: zh ? "CT 探员" : "CT agent",
    music_kit: zh ? "音乐盒" : "Music kit" };
  const original = zh ? "沿用 Demo 原设置" : "Use original demo setting";
  const name = item => (zh ? item?.nameZh : item?.nameEn) || item?.nameEn || original;
  const id = (item, key) => key === "music_kit" ? item.index : item.def;
  const candidates = useMemo(() => field ? loadoutCandidates(field) : [], [field]);
  const shown = candidates.filter(item => `${item.nameZh} ${item.nameEn}`.toLowerCase().includes(query.trim().toLowerCase()));
  const select = item => {
    const next = { ...value };
    if (item) next[field] = id(item, field);
    else delete next[field];
    onChange(next);
    setField(null);
  };
  return <section className="mb-5 rounded-xl border border-cs2-border bg-cs2-bg-card p-3" data-testid="player-loadout-editor">
    <div className="mb-3">
      <h3 className="text-xs font-bold text-cs2-text-primary">{zh ? "探员与音乐盒" : "Agents & music kit"}</h3>
      <p className="mt-1 text-[11px] text-cs2-text-muted">{zh
        ? "探员按 T / CT 分别设置，仅支持同阵营替换。音乐盒在玩家获得 MVP 时自然播放，选择后保存方案。"
        : "Choose an agent for each side; only same-team replacements are supported. Music plays on the player's MVP. Save the plan to apply."}</p>
    </div>
    <div className="grid grid-cols-3 gap-3">
      {Object.keys(labels).map(key => {
        const item = loadoutCandidates(key).find(row => id(row, key) === value[key]);
        const Icon = key === "music_kit" ? Music2 : UserRound;
        return <button key={key} type="button" disabled={!editable} aria-label={labels[key]}
          onClick={() => { setQuery(""); setField(key); }}
          className="flex min-h-24 items-center gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input p-3 text-left transition-colors enabled:hover:border-cs2-accent disabled:cursor-default">
          {item?.image && onlineAssetsEnabled ? <img alt="" src={item.image.startsWith("http") ? item.image : `https://cdn.cstrike.app${item.image}`} className="h-16 w-16 shrink-0 object-contain" />
            : <Icon className="h-9 w-9 shrink-0 text-cs2-text-muted" />}
          <span className="min-w-0"><span className="block text-[10px] font-bold text-cs2-text-muted">{labels[key]}</span>
            <span className="mt-1 block text-xs text-cs2-text-primary">{name(item)}</span>
            {editable ? <span className="mt-1 block text-[10px] text-cs2-accent">{zh ? "选择款式" : "Choose"}</span> : null}</span>
        </button>;
      })}
    </div>
    <Modal open={Boolean(field) && editable} onClose={() => setField(null)} title={labels[field] || ""} maxWidth="max-w-3xl" zIndex={190}>
      <div className="space-y-3 p-4">
        <label className="flex items-center gap-2 rounded-lg border border-cs2-border px-3 py-2">
          <Search className="h-4 w-4 text-cs2-text-muted" />
          <input value={query} onChange={e => setQuery(e.target.value)} aria-label={zh ? "搜索款式" : "Search styles"}
            placeholder={zh ? "搜索名称…" : "Search names…"} className="w-full bg-transparent text-sm text-cs2-text-primary outline-none" />
        </label>
        <button type="button" onClick={() => select(null)} className="rounded-lg border border-cs2-border px-3 py-2 text-xs text-cs2-text-secondary">{original}</button>
        <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto">
          {shown.map(item => <button key={id(item, field)} type="button" onClick={() => select(item)}
            className={`relative rounded-lg border p-3 text-left hover:border-cs2-accent ${value[field] === id(item, field) ? "border-cs2-accent bg-cs2-accent-soft" : "border-cs2-border bg-cs2-bg-input"}`}>
            {value[field] === id(item, field) ? <Check className="absolute right-2 top-2 h-4 w-4 text-cs2-accent" /> : null}
            {onlineAssetsEnabled && item.image ? <img loading="lazy" alt="" src={item.image.startsWith("http") ? item.image : `https://cdn.cstrike.app${item.image}`} className="mb-2 h-24 w-full object-contain" /> : null}
            <span className="block text-xs text-cs2-text-primary">{name(item)}</span>
          </button>)}
        </div>
        {!shown.length ? <p className="text-xs text-cs2-text-muted">{zh ? "没有匹配的款式" : "No matching styles"}</p> : null}
      </div>
    </Modal>
  </section>;
}
