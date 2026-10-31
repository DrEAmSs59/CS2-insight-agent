import { useMemo, useState } from "react";
import { Check, ChevronRight, Music2, Search, UserRound } from "lucide-react";
import Modal from "../../../components/ui/Modal.jsx";
import { CS2_COSMETICS_ITEMS } from "../../../generated/cs2CosmeticsCatalog.js";
import { IconTile } from "../AnalysisUi.jsx";

export function loadoutCandidates(field) {
  const rows = CS2_COSMETICS_ITEMS.filter(item => field === "music_kit"
    ? item.type === "musickit" && Number(item.index) > 0
    : item.type === "agent" && item.teams === (field === "agent_t" ? 0 : 1));
  return [...new Map(rows.map(item => [field === "music_kit" ? item.index : item.def, item])).values()];
}

function imageSrc(image) {
  return image.startsWith("http") ? image : `https://cdn.cstrike.app${image}`;
}

export default function PlayerLoadoutEditor({ value, onChange, editable, locale, onlineAssetsEnabled, team, evidence = [], renderItem }) {
  const [field, setField] = useState(null);
  const [query, setQuery] = useState("");
  const zh = String(locale).startsWith("zh");
  const labels = { agent_t: zh ? "T 探员" : "T agent", agent_ct: zh ? "CT 探员" : "CT agent",
    music_kit: zh ? "音乐盒" : "Music kit" };
  const fields = team ? [team === "ct" ? "agent_ct" : "agent_t", "music_kit"] : Object.keys(labels);
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
  const usingOriginal = field ? value[field] === undefined : false;
  const openSlot = key => { setQuery(""); setField(key); };
  return <section className={team ? "contents" : "mb-5"} data-testid={team ? `player-loadout-slots-${team}` : "player-loadout-editor"}>
    {!team && <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="text-[13px] font-semibold text-cs2-text-primary">{zh ? "探员与音乐盒" : "Agents & music kit"}</h3>
      <p className="text-xs text-cs2-text-muted">{zh
        ? "探员按 T / CT 分别设置，仅支持同阵营替换。音乐盒在玩家获得 MVP 时自然播放，选择后保存方案。"
        : "Choose an agent for each side; only same-team replacements are supported. Music plays on the player's MVP. Save the plan to apply."}</p>
    </div>}
    <div className={team ? "contents" : "grid gap-2 sm:grid-cols-3"}>
      {fields.map(key => {
        const item = loadoutCandidates(key).find(row => id(row, key) === value[key]);
        if (team && renderItem) {
          const originals = evidence.filter(row => row.type === (key === "music_kit" ? "musickit" : "agent"));
          const rows = item ? [{
            catalog_id: item.id, def_index: item.def, paint_index: item.index || 0, type: item.type,
            name_zh: item.nameZh, name_en: item.nameEn, image_url: item.image ? imageSrc(item.image) : "",
            rarity: item.rarity, teams: item.teams, observed_teams: [team],
          }] : originals;
          if (rows.length) return rows.map((row, index) => renderItem({ item: row, field: key,
            key: `${key}:${row.catalog_id || row.def_index}:${index}`, onSelect: () => openSlot(key) }));
          return editable ? <button key={key} type="button" data-loadout-slot={key} aria-label={labels[key]}
            className="self-start rounded-lg border border-dashed border-cs2-border px-3 py-2 text-xs text-cs2-text-secondary hover:border-cs2-accent hover:text-cs2-accent"
            onClick={() => openSlot(key)}>{zh ? `选择${labels[key]}` : `Choose ${labels[key]}`}</button> : null;
        }
        const Icon = key === "music_kit" ? Music2 : UserRound;
        return <button key={key} type="button" disabled={!editable} aria-label={labels[key]}
          data-loadout-slot={key}
          onClick={() => openSlot(key)}
          className={`analysis-card flex text-left disabled:cursor-default ${team ? "w-full min-w-0 flex-col overflow-hidden" : "min-h-[76px] items-center gap-3 p-3"} ${editable ? "analysis-card--interactive" : ""}`}>
          <span className={team ? "cosmetic-preview-surface flex aspect-[4/3] w-full items-center justify-center overflow-hidden" : "cosmetic-preview-surface flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg"}>
            {item?.image && onlineAssetsEnabled
              ? <img alt="" src={imageSrc(item.image)} className={`h-full w-full object-contain ${team ? "p-2" : ""}`} />
              : <IconTile icon={Icon} tone={item ? "accent" : "neutral"} className="!h-14 !w-14 [&>svg]:h-6 [&>svg]:w-6" />}
          </span>
          <span className={team ? "block w-full min-w-0 border-t border-cs2-border-subtle px-2.5 py-2" : "min-w-0 flex-1"}>
            <span className="block text-xs text-cs2-text-muted">{labels[key]}</span>
            <span className="mt-0.5 block truncate text-[13px] font-semibold text-cs2-text-primary">{name(item)}</span>
          </span>
          {editable && !team ? <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold text-cs2-accent">{zh ? "选择款式" : "Choose"}<ChevronRight className="h-3.5 w-3.5" aria-hidden /></span> : null}
        </button>;
      })}
    </div>
    <Modal open={Boolean(field) && editable} onClose={() => setField(null)} title={labels[field] || ""} maxWidth="max-w-3xl" zIndex={190}
      contentClassName="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
        <label className="relative block shrink-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cs2-text-muted" aria-hidden />
          <input value={query} onChange={e => setQuery(e.target.value)} aria-label={zh ? "搜索款式" : "Search styles"}
            placeholder={zh ? "搜索名称…" : "Search names…"}
            className="h-9 w-full rounded-[10px] border border-cs2-border bg-cs2-bg-input pl-9 pr-3 text-[13px] text-cs2-text-primary outline-none transition-colors placeholder:text-cs2-text-muted focus:border-cs2-accent" />
        </label>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <button type="button" aria-pressed={usingOriginal} data-active={usingOriginal ? "true" : "false"} onClick={() => select(null)} className="analysis-tag-chip">{original}</button>
          <span className="text-xs text-cs2-text-muted">{zh ? `共 ${shown.length} 个` : `${shown.length} items`}</span>
        </div>
        {shown.length ? <div className="grid min-h-0 flex-1 grid-cols-3 content-start gap-2 overflow-y-auto pr-1">
          {shown.map(item => {
            const active = value[field] === id(item, field);
            return <button key={id(item, field)} type="button" aria-label={name(item)} onClick={() => select(item)} data-active={active ? "true" : "false"}
              className="analysis-card analysis-card--interactive relative p-3 text-left">
              {active ? <Check className="absolute right-2 top-2 h-4 w-4 text-cs2-accent" /> : null}
              {onlineAssetsEnabled && item.image ? <img loading="lazy" alt="" src={imageSrc(item.image)} className="mb-2 h-24 w-full object-contain" /> : null}
              <span className="block text-xs font-medium text-cs2-text-primary">{name(item)}</span>
              {item.type === "agent" ? <span className="mt-1 block text-[11px] text-cs2-text-muted">
                {item.teams === 0 ? "T" : "CT"}
              </span> : null}
            </button>;
          })}
        </div> : <p className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-cs2-border p-8 text-center text-[13px] text-cs2-text-muted">{zh ? "没有匹配的款式" : "No matching styles"}</p>}
    </Modal>
  </section>;
}
