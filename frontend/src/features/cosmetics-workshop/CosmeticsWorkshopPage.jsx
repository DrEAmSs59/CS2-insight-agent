import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Box, Check, ChevronRight, CirclePlus, Crosshair, Dices, Eye, Gem, Hand,
  Layers3, MousePointer2, Plus, Rotate3D, Search, Shield, Sparkles, Sword,
  Trash2, ZoomIn,
} from "lucide-react";
import PageContainer from "../../components/PageContainer.jsx";
import Button from "../../components/ui/Button.jsx";
import Modal from "../../components/ui/Modal.jsx";
import { useLocaleStore } from "../../i18n/localeStore.js";
import { useT } from "../../i18n/useT.js";
import { CS2_COSMETICS_ITEMS } from "../../generated/cs2CosmeticsCatalog.js";
import { buildCs2ViewerUrl } from "../../utils/cs2Inspect.js";
import { imageUrlForWear, listDefaultLoadout, sortCandidatesByRarityDesc } from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

const IMAGE_BASE = "https://cdn.cstrike.app";
const TYPE_ORDER = ["melee", "glove", "weapon"];
const TYPE_META = {
  melee: { icon: Sword, labelKey: "cosmeticsWorkshop.type.melee" },
  glove: { icon: Hand, labelKey: "cosmeticsWorkshop.type.glove" },
  weapon: { icon: Crosshair, labelKey: "cosmeticsWorkshop.type.weapon" },
};
const CATEGORY_ORDER = ["secondary", "rifle", "smg", "heavy"];

function absoluteImage(image) {
  const source = String(image || "");
  return source.startsWith("http") ? source : `${IMAGE_BASE}${source}`;
}

function toWorkshopItem(raw) {
  return {
    ...raw,
    catalog_id: Number(raw.catalog_id ?? raw.id),
    def_index: Number(raw.def_index ?? raw.def),
    paint_index: Number(raw.paint_index ?? raw.index ?? 0),
    name_en: String(raw.name_en ?? raw.nameEn ?? raw.model ?? ""),
    name_zh: String(raw.name_zh ?? raw.nameZh ?? raw.nameEn ?? raw.model ?? ""),
    alt_name: String(raw.alt_name ?? raw.altName ?? ""),
    image_url: absoluteImage(raw.image_url ?? raw.image),
    wear_min: Number.isFinite(Number(raw.wear_min ?? raw.wearMin)) ? Number(raw.wear_min ?? raw.wearMin) : 0,
    wear_max: Number.isFinite(Number(raw.wear_max ?? raw.wearMax)) ? Number(raw.wear_max ?? raw.wearMax) : 1,
    is_base: Boolean(raw.base || raw.is_base || raw.is_placeholder || Number(raw.paint_index ?? raw.index ?? 0) === 0),
  };
}

const ALL_BASE_ITEMS = CS2_COSMETICS_ITEMS
  .filter((item) => item.base && TYPE_ORDER.includes(String(item.type || "")))
  .map(toWorkshopItem);
const ALL_SKINS = CS2_COSMETICS_ITEMS
  .filter((item) => !item.base && TYPE_ORDER.includes(String(item.type || "")))
  .map(toWorkshopItem);
const SKIN_COUNT_BY_DEF = ALL_SKINS.reduce((counts, item) => {
  const key = `${item.type}:${item.def_index}`;
  counts.set(key, (counts.get(key) || 0) + 1);
  return counts;
}, new Map());
const CATALOG_BASE_ITEMS = ALL_BASE_ITEMS.filter((item) => SKIN_COUNT_BY_DEF.has(`${item.type}:${item.def_index}`));

function localizedName(item, locale) {
  return String(locale || "").startsWith("zh")
    ? String(item?.name_zh || item?.name_en || "")
    : String(item?.name_en || item?.name_zh || "");
}

function nameParts(item, locale) {
  const [model = "", ...finishParts] = localizedName(item, locale).split("|").map((part) => part.trim());
  return { model, finish: finishParts.join(" | "), alt: String(item?.alt_name || "").trim() };
}

function defaultWear(item) {
  const min = Number(item?.wear_min ?? 0);
  const max = Number(item?.wear_max ?? 1);
  return Math.min(max, Math.max(min, 0.07));
}

function previewImage(item, wear = defaultWear(item)) {
  return imageUrlForWear(item?.image_url, wear, item);
}

function supportsHosted3d(item) {
  return ["weapon", "melee"].includes(String(item?.type || "")) && !item?.is_base;
}

function ItemImage({ item, wear, className = "" }) {
  const [failed, setFailed] = useState(false);
  const source = failed ? "" : previewImage(item, wear);
  useEffect(() => setFailed(false), [item?.catalog_id, wear]);
  if (!source) return <span className={`flex items-center justify-center text-cs2-text-muted ${className}`}><Box className="h-8 w-8 opacity-45" /></span>;
  return <img src={source} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} className={`object-contain ${className}`} />;
}

function CategoryButton({ type, active, count, onClick }) {
  const t = useT();
  const { icon: Icon, labelKey } = TYPE_META[type];
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={`group flex min-w-[150px] flex-1 items-center gap-3 rounded-[10px] border px-4 py-3 text-left transition-colors ${active ? "border-cs2-accent/55 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-card text-cs2-text-secondary hover:border-cs2-accent/30 hover:bg-cs2-bg-hover"}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${active ? "border-cs2-accent/30 bg-cs2-bg-page/60" : "border-cs2-border-subtle bg-cs2-bg-input"}`}><Icon className="h-[18px] w-[18px]" /></span>
      <span className="min-w-0 flex-1"><span className="block text-[12px] font-black">{t(labelKey)}</span><span className="mt-0.5 block font-mono text-[9px] text-cs2-text-muted">{t("cosmeticsWorkshop.typeCount", { count })}</span></span>
      <ChevronRight className={`h-3.5 w-3.5 ${active ? "text-cs2-accent" : "opacity-30"}`} />
    </button>
  );
}

function BaseItemCard({ item, locale, skinCount, compact = false, currentItem, onClick }) {
  const t = useT();
  const shown = currentItem || item;
  const parts = nameParts(shown, locale);
  const changed = Boolean(currentItem && !currentItem.is_base);
  return (
    <button type="button" onClick={onClick} aria-label={localizedName(item, locale)} className={`group relative flex min-w-0 flex-col overflow-hidden rounded-[10px] border text-left transition-all hover:-translate-y-0.5 hover:border-cs2-accent/40 hover:bg-cs2-bg-elevated ${changed ? "border-cs2-accent/50 bg-cs2-accent-soft/30" : "border-cs2-border bg-cs2-bg-card"} ${compact ? "min-h-[132px]" : "min-h-[190px]"}`}>
      <div className={`cosmetic-preview-surface relative flex items-center justify-center overflow-hidden border-b border-cs2-border-subtle ${compact ? "h-[88px] p-2" : "h-[138px] p-4"}`}>
        <ItemImage item={shown} className="h-full w-full transition-transform duration-200 group-hover:scale-[1.04]" />
        <span className="absolute left-2 top-2 rounded-[4px] border border-white/10 bg-black/35 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white/70">{changed ? t("cosmeticsWorkshop.scheme.equipped") : t("cosmeticsWorkshop.base.original")}</span>
        {!compact ? <span className="absolute bottom-2 right-2 rounded-[4px] border border-white/10 bg-black/35 px-1.5 py-0.5 font-mono text-[8px] text-white/70">{t("cosmeticsWorkshop.base.skinCount", { count: skinCount })}</span> : null}
      </div>
      <div className={`flex min-w-0 flex-1 items-center justify-between gap-2 ${compact ? "px-2 py-2" : "px-3 py-2.5"}`}>
        <div className="min-w-0"><span className={`${compact ? "text-[9px]" : "text-[11px]"} block truncate font-bold text-cs2-text-secondary`}>{parts.model}</span>{parts.finish ? <span className="mt-0.5 block truncate text-[8px]" style={{ color: shown.rarity }}>{parts.finish}</span> : null}</div>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-cs2-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-cs2-accent" />
      </div>
    </button>
  );
}

function SkinCard({ item, baseItem, locale, selected, onSelect, onInspect }) {
  const t = useT();
  const parts = nameParts(item, locale);
  const original = Boolean(item?.is_base);
  return (
    <article className={`cosmetic-preview-surface group relative flex min-h-[164px] min-w-0 flex-col overflow-hidden rounded-[10px] border transition-colors ${selected ? "border-cs2-accent ring-1 ring-cs2-accent/30" : "border-cs2-border hover:border-cs2-text-muted"}`}>
      <button type="button" onClick={onSelect} aria-pressed={selected} aria-label={localizedName(item, locale)} className="flex min-h-0 flex-1 flex-col text-left">
        <span className="relative flex h-[112px] items-center justify-center p-2.5"><ItemImage item={item} className="h-full w-full transition-transform group-hover:scale-[1.035]" />{selected ? <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-cs2-accent text-white"><Check className="h-3 w-3" /></span> : null}</span>
        <span className="block min-w-0 border-t border-cs2-border bg-cs2-bg-card px-2.5 py-2"><span className="block truncate text-[9px] font-semibold text-cs2-text-secondary">{original ? localizedName(baseItem, locale) : parts.finish || parts.model}</span><span className="mt-0.5 block truncate text-[8px] text-cs2-text-muted">{original ? t("cosmeticsWorkshop.base.original") : parts.alt || parts.model}</span></span>
      </button>
      {!original ? <button type="button" onClick={onInspect} className="flex h-7 items-center justify-center gap-1.5 border-t border-cs2-border bg-cs2-bg-input/85 text-[8px] font-bold text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-accent">{supportsHosted3d(item) ? <Rotate3D className="h-3 w-3" /> : <Eye className="h-3 w-3" />}{supportsHosted3d(item) ? t("cosmeticsWorkshop.skin.inspect3d") : t("cosmeticsWorkshop.skin.inspect")}</button> : null}
    </article>
  );
}

function ParamControl({ label, value, min, max, step, onChange, onRandom }) {
  const progress = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center justify-between gap-3 text-[9px] font-semibold text-cs2-text-muted"><span>{label}</span><output className="font-mono text-cs2-text-secondary">{step < 1 ? Number(value).toFixed(6) : Math.round(value)}</output></span>
      <span className="flex items-center gap-2"><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="cs2-data-slider min-w-0 flex-1" style={{ "--cs2-range-progress": `${progress}%` }} /><button type="button" onClick={onRandom} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cs2-border bg-cs2-bg-input text-cs2-text-muted hover:text-cs2-accent"><Dices className="h-3.5 w-3.5" /></button></span>
    </label>
  );
}

function InspectModal({ item, locale, onClose }) {
  const t = useT();
  const [wear, setWear] = useState(() => defaultWear(item));
  const [seed, setSeed] = useState(432);
  const viewerUrl = supportsHosted3d(item) ? buildCs2ViewerUrl({ ...item, paint_wear: wear, paint_seed: seed }) : "";
  useEffect(() => { setWear(defaultWear(item)); setSeed(432); }, [item]);
  return (
    <Modal open={Boolean(item)} onClose={onClose} title={t("cosmeticsWorkshop.inspect.title")} subtitle={item ? localizedName(item, locale) : ""} icon={<Rotate3D className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-[920px]" maxHeight="max-h-[86vh]" className="!h-auto" contentClassName="overflow-y-auto" zIndex={120} footer={<div className="flex justify-end"><Button variant="secondary" size="sm" onClick={onClose}>{t("common.close")}</Button></div>}>
      <div className="p-4">
        <div className="cosmetic-preview-surface relative h-[min(540px,58vh)] overflow-hidden rounded-[10px] border border-cs2-border">
          {viewerUrl ? <iframe title={t("cosmeticsWorkshop.inspect.title")} src={viewerUrl} allow="fullscreen" className="h-full w-full border-0 bg-transparent" /> : <div className="flex h-full flex-col items-center justify-center p-8 text-center"><ItemImage item={item} wear={wear} className="h-[260px] w-full" /><div className="mt-3 inline-flex max-w-md items-start gap-2 rounded-lg border border-cs2-border bg-black/25 px-3 py-2 text-[9px] leading-relaxed text-white/65"><Layers3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cs2-accent" />{t("cosmeticsWorkshop.inspect.gloveFallback")}</div></div>}
          <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-[4px] border border-white/10 bg-black/35 px-2 py-1 text-[8px] font-bold text-white/75"><span className={`h-1.5 w-1.5 rounded-full ${viewerUrl ? "bg-emerald-400" : "bg-cs2-accent"}`} />{viewerUrl ? t("cosmeticsWorkshop.inspect.live") : t("cosmeticsWorkshop.inspect.material")}</span>
        </div>
        <div className="mt-3 grid gap-3 rounded-[10px] border border-cs2-border bg-cs2-bg-input/40 p-3 sm:grid-cols-2"><ParamControl label={t("analysis.cosmetics.picker.wear")} value={wear} min={item?.wear_min ?? 0} max={item?.wear_max ?? 1} step={0.000001} onChange={setWear} onRandom={() => setWear((item?.wear_min ?? 0) + Math.random() * ((item?.wear_max ?? 1) - (item?.wear_min ?? 0)))} /><ParamControl label={t("analysis.cosmetics.picker.seed")} value={seed} min={0} max={1000} step={1} onChange={setSeed} onRandom={() => setSeed(Math.floor(Math.random() * 1001))} /></div>
        {viewerUrl ? <div className="mt-2 flex justify-end gap-3 text-[8px] text-cs2-text-muted"><span className="inline-flex items-center gap-1"><MousePointer2 className="h-3 w-3" />{t("cosmeticsWorkshop.inspect.rotate")}</span><span className="inline-flex items-center gap-1"><ZoomIn className="h-3 w-3" />{t("cosmeticsWorkshop.inspect.zoom")}</span></div> : null}
      </div>
    </Modal>
  );
}

function skinCandidatesFor(baseItem, allowAllTypes) {
  if (!baseItem) return [];
  const rows = ALL_SKINS.filter((item) => {
    if (item.type !== baseItem.type) return false;
    if (allowAllTypes && ["melee", "glove"].includes(baseItem.type)) return true;
    return Number(item.def_index) === Number(baseItem.def_index);
  });
  return sortCandidatesByRarityDesc(rows);
}

function SkinPickerModal({ state, locale, onClose, onInspect, onConfirm }) {
  const t = useT();
  const baseItem = state?.baseItem;
  const schemeMode = state?.mode === "scheme";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const candidates = useMemo(() => skinCandidatesFor(baseItem, schemeMode), [baseItem, schemeMode]);
  useEffect(() => { if (state) { setQuery(""); setSelected(state.currentItem || baseItem); } }, [baseItem, state]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((item) => `${item.name_zh} ${item.name_en} ${item.alt_name} ${item.model}`.toLowerCase().includes(q));
  }, [candidates, query]);
  const allItems = schemeMode ? [baseItem, ...filtered] : filtered;
  return (
    <Modal open={Boolean(state)} onClose={onClose} title={baseItem ? t("cosmeticsWorkshop.skin.title", { name: localizedName(baseItem, locale) }) : ""} subtitle={t(schemeMode ? "cosmeticsWorkshop.skin.schemeSubtitle" : "cosmeticsWorkshop.skin.browseSubtitle", { count: candidates.length })} icon={<Sparkles className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-[1180px]" maxHeight="max-h-[90vh]" contentClassName="min-h-0 overflow-hidden" zIndex={110} footer={schemeMode ? <div className="flex items-center justify-between gap-3"><span className="truncate text-[9px] text-cs2-text-muted">{selected ? t("cosmeticsWorkshop.skin.selected", { name: localizedName(selected, locale) }) : ""}</span><div className="flex gap-2"><Button variant="secondary" size="sm" onClick={onClose}>{t("analysis.cosmetics.picker.cancel")}</Button><Button size="sm" disabled={!selected} onClick={() => onConfirm(selected)}><Check className="h-3.5 w-3.5" />{t("cosmeticsWorkshop.skin.confirm")}</Button></div></div> : <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={onClose}>{t("common.close")}</Button></div>}>
      <div className="grid h-[min(720px,calc(90vh-8.5rem))] min-h-0 grid-cols-[220px_minmax(0,1fr)] gap-4 overflow-hidden p-4 max-[760px]:grid-cols-1">
        <aside className="flex min-h-0 flex-col rounded-[10px] border border-cs2-border bg-cs2-bg-input/40 p-3 max-[760px]:hidden"><span className="text-[9px] font-bold uppercase tracking-[0.12em] text-cs2-text-muted">{t("cosmeticsWorkshop.skin.entry")}</span><div className="cosmetic-preview-surface mt-2 flex h-[150px] items-center justify-center rounded-lg border border-cs2-border p-3"><ItemImage item={baseItem} className="h-full w-full" /></div><h3 className="mt-3 text-[12px] font-black text-cs2-text-primary">{localizedName(baseItem, locale)}</h3><p className="mt-1 text-[9px] leading-relaxed text-cs2-text-muted">{t(schemeMode ? "cosmeticsWorkshop.skin.schemeHint" : "cosmeticsWorkshop.skin.browseHint")}</p><div className="mt-auto rounded-lg border border-cs2-border-subtle bg-cs2-bg-card p-2.5"><div className="flex items-center justify-between text-[9px]"><span className="text-cs2-text-muted">{t("cosmeticsWorkshop.skin.total")}</span><strong className="font-mono text-cs2-text-secondary">{candidates.length}</strong></div><div className="mt-2 flex items-center justify-between text-[9px]"><span className="text-cs2-text-muted">{t("cosmeticsWorkshop.skin.source")}</span><strong className="text-cs2-text-secondary">cs-lib</strong></div></div></aside>
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden"><label className="relative mb-3 block shrink-0"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("cosmeticsWorkshop.skin.search")} className="h-9 w-full rounded-md border border-cs2-border bg-cs2-bg-input pl-9 pr-3 text-[10px] text-cs2-text-primary outline-none placeholder:text-cs2-text-muted focus:border-cs2-accent" /></label><div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 content-start gap-2.5 overflow-y-auto pr-1 sm:grid-cols-4 xl:grid-cols-5" data-testid="workshop-skin-list">{allItems.map((item) => <SkinCard key={`${item.catalog_id}-${item.paint_index}`} item={item} baseItem={baseItem} locale={locale} selected={selected?.catalog_id === item.catalog_id} onSelect={() => setSelected(item)} onInspect={() => onInspect(item)} />)}</div></section>
      </div>
    </Modal>
  );
}

function loadoutForTeam(team) {
  return listDefaultLoadout(team).map((raw) => {
    const item = toWorkshopItem(raw);
    const base = ALL_BASE_ITEMS.find((candidate) => candidate.model === item.model && candidate.type === item.type);
    return { ...item, category: base?.category || "" };
  });
}

const TEAM_LOADOUTS = { ct: loadoutForTeam("ct"), t: loadoutForTeam("t") };

function slotKey(item) {
  if (item.type === "weapon") return `weapon:${item.model}`;
  return item.type;
}

function groupLoadout(items) {
  const groups = [];
  const special = items.filter((item) => ["melee", "glove"].includes(item.type));
  if (special.length) groups.push({ key: "special", items: special });
  for (const category of CATEGORY_ORDER) {
    const rows = items.filter((item) => item.type === "weapon" && item.category === category);
    if (rows.length) groups.push({ key: category, items: rows });
  }
  return groups;
}

function SchemeManagerModal({ open, plans, setPlans, locale, onClose, onEditSlot }) {
  const t = useT();
  const [team, setTeam] = useState("ct");
  const [notice, setNotice] = useState("");
  const plan = plans[0] || null;
  const groups = groupLoadout(TEAM_LOADOUTS[team]);

  useEffect(() => {
    if (open) setNotice("");
  }, [open]);

  const addPlan = () => {
    if (plans.length) return;
    setPlans([{ id: "plan-1", name: t("cosmeticsWorkshop.scheme.defaultName"), selections: { ct: {}, t: {} } }]);
  };

  const deletePlan = () => {
    setPlans([]);
    setNotice("");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("cosmeticsWorkshop.scheme.title")}
      subtitle={t("cosmeticsWorkshop.scheme.subtitle")}
      icon={<Gem className="h-4 w-4 text-cs2-accent" />}
      maxWidth="max-w-[1280px]"
      maxHeight="max-h-[92vh]"
      contentClassName="min-h-0 overflow-hidden"
      footer={plan ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[9px] text-cs2-text-muted">{notice || t("cosmeticsWorkshop.scheme.footerHint")}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setNotice(t("cosmeticsWorkshop.scheme.saved"))}>{t("cosmeticsWorkshop.scheme.save")}</Button>
            <Button size="sm" onClick={() => setNotice(t("cosmeticsWorkshop.scheme.applied"))}><Sparkles className="h-3.5 w-3.5" />{t("cosmeticsWorkshop.scheme.apply")}</Button>
          </div>
        </div>
      ) : null}
    >
      <div className="grid h-[min(760px,calc(92vh-8.5rem))] min-h-0 grid-cols-[230px_minmax(0,1fr)] overflow-hidden max-[760px]:grid-cols-1">
        <aside className="flex min-h-0 flex-col border-r border-cs2-border bg-cs2-bg-input/35 p-3 max-[760px]:border-b max-[760px]:border-r-0">
          <div className="flex items-center justify-between gap-2"><span className="text-[9px] font-black uppercase tracking-[0.12em] text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.list")}</span><span className="font-mono text-[8px] text-cs2-text-muted">{plans.length}/1</span></div>
          <button type="button" onClick={addPlan} disabled={plans.length >= 1} className="mt-3 flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed border-cs2-accent/45 bg-cs2-accent-soft text-[9px] font-bold text-cs2-accent hover:border-cs2-accent disabled:cursor-not-allowed disabled:border-cs2-border disabled:bg-transparent disabled:text-cs2-text-muted disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{t("cosmeticsWorkshop.scheme.create")}</button>
          {plan ? (
            <div className="mt-3 rounded-[10px] border border-cs2-accent/50 bg-cs2-bg-card p-3 shadow-sm">
              <div className="flex items-start justify-between gap-2"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cs2-accent/25 bg-cs2-accent-soft text-cs2-accent"><Gem className="h-4 w-4" /></span><button type="button" onClick={deletePlan} aria-label={t("cosmeticsWorkshop.scheme.delete")} className="rounded-md p-1.5 text-cs2-text-muted hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button></div>
              <h3 className="mt-3 text-[11px] font-black text-cs2-text-primary">{plan.name}</h3><p className="mt-1 text-[8px] text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.defaultState")}</p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center py-8 text-center"><CirclePlus className="h-7 w-7 text-cs2-text-muted opacity-50" /><p className="mt-3 text-[10px] font-bold text-cs2-text-secondary">{t("cosmeticsWorkshop.scheme.empty")}</p><p className="mt-1 max-w-[170px] text-[8px] leading-relaxed text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.emptyHint")}</p></div>
          )}
          <p className="mt-auto rounded-lg border border-cs2-border-subtle bg-cs2-bg-card/70 p-2 text-[8px] leading-relaxed text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.limitHint")}</p>
        </aside>

        {plan ? (
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden p-4">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-cs2-border-subtle pb-3">
              <div><h3 className="text-[13px] font-black text-cs2-text-primary">{plan.name}</h3><p className="mt-0.5 text-[8px] text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.editHint")}</p></div>
              <div className="flex rounded-lg border border-cs2-border bg-cs2-bg-input p-1">
                {["ct", "t"].map((key) => (
                  <button key={key} type="button" aria-pressed={team === key} onClick={() => setTeam(key)} className={`flex min-w-[88px] items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[9px] font-black transition-colors ${team === key ? (key === "ct" ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300") : "text-cs2-text-muted hover:text-cs2-text-secondary"}`}><Shield className="h-3.5 w-3.5" />{key.toUpperCase()} · {TEAM_LOADOUTS[key].length}</button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {groups.map((group) => (
                <div key={group.key} className="mt-4 first:mt-3">
                  <div className="mb-2 flex items-center gap-2"><h4 className="text-[9px] font-black uppercase tracking-[0.12em] text-cs2-text-muted">{t(`cosmeticsWorkshop.loadout.${group.key}`)}</h4><span className="font-mono text-[8px] text-cs2-text-muted">{group.items.length}</span></div>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {group.items.map((item) => {
                      const currentItem = plan.selections?.[team]?.[slotKey(item)] || null;
                      return <BaseItemCard key={slotKey(item)} item={item} currentItem={currentItem} locale={locale} skinCount={skinCandidatesFor(item, ["melee", "glove"].includes(item.type)).length} compact onClick={() => onEditSlot({ team, baseItem: item, currentItem })} />;
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <section className="flex min-h-[360px] flex-col items-center justify-center p-8 text-center"><Gem className="h-10 w-10 text-cs2-text-muted opacity-35" /><h3 className="mt-4 text-[13px] font-black text-cs2-text-secondary">{t("cosmeticsWorkshop.scheme.noPlan")}</h3><p className="mt-1 text-[9px] text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.noPlanHint")}</p><Button size="sm" onClick={addPlan} className="mt-4"><Plus className="h-3.5 w-3.5" />{t("cosmeticsWorkshop.scheme.create")}</Button></section>
        )}
      </div>
    </Modal>
  );
}

export default function CosmeticsWorkshopPage() {
  const t = useT();
  const locale = useLocaleStore((state) => state.effectiveLocale);
  const [activeType, setActiveType] = useState("melee");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [skinPicker, setSkinPicker] = useState(null);
  const [inspectItem, setInspectItem] = useState(null);
  const [schemeOpen, setSchemeOpen] = useState(false);
  const [plans, setPlans] = useState(() => [{ id: "plan-1", name: t("cosmeticsWorkshop.scheme.defaultName"), selections: { ct: {}, t: {} } }]);

  const typeCounts = useMemo(() => Object.fromEntries(TYPE_ORDER.map((type) => [type, CATALOG_BASE_ITEMS.filter((item) => item.type === type).length])), []);
  const filteredItems = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return CATALOG_BASE_ITEMS
      .filter((item) => item.type === activeType)
      .filter((item) => !q || `${item.name_zh} ${item.name_en} ${item.model}`.toLowerCase().includes(q))
      .sort((left, right) => localizedName(left, locale).localeCompare(localizedName(right, locale)));
  }, [activeType, deferredQuery, locale]);

  const editSchemeSlot = ({ team, baseItem, currentItem }) => {
    setSkinPicker({ mode: "scheme", team, baseItem, currentItem: currentItem || baseItem });
  };

  const confirmSchemeSelection = (item) => {
    const { team, baseItem } = skinPicker;
    setPlans((current) => current.map((plan) => ({
      ...plan,
      selections: {
        ...plan.selections,
        [team]: { ...plan.selections[team], [slotKey(baseItem)]: item?.is_base ? undefined : item },
      },
    })));
    setSkinPicker(null);
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-cs2-bg-page">
      <PageContainer className="!h-auto min-h-full !max-w-[1720px] pb-10">
        <header className="flex flex-col gap-4 border-b border-cs2-border-subtle pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent"><Gem className="h-[18px] w-[18px]" /></span><div><h1 className="text-xl font-black tracking-tight text-cs2-text-primary">{t("cosmeticsWorkshop.title")}</h1><p className="mt-0.5 text-[10px] text-cs2-text-muted">{t("cosmeticsWorkshop.subtitle")}</p></div><span className="rounded-[4px] border border-cs2-border bg-cs2-bg-input px-2 py-1 font-mono text-[8px] font-bold uppercase tracking-[0.12em] text-cs2-text-muted">CS-LIB · {CATALOG_BASE_ITEMS.length}</span></div></div>
          <Button size="md" onClick={() => setSchemeOpen(true)} className="shrink-0"><Gem className="h-4 w-4" />{t("cosmeticsWorkshop.scheme.button")}<span className="rounded bg-black/20 px-1.5 py-0.5 font-mono text-[8px]">{plans.length}/1</span></Button>
        </header>

        <div className="mt-4 flex flex-wrap gap-2" aria-label={t("cosmeticsWorkshop.categories")}>
          {TYPE_ORDER.map((type) => <CategoryButton key={type} type={type} active={activeType === type} count={typeCounts[type]} onClick={() => { setActiveType(type); setQuery(""); }} />)}
        </div>

        <section className="mt-3 min-w-0">
          <div className="flex flex-col gap-3 rounded-[10px] border border-cs2-border bg-cs2-bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="relative block w-full max-w-[520px] min-w-0"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("cosmeticsWorkshop.search")} className="h-9 w-full rounded-md border border-cs2-border bg-cs2-bg-input pl-9 pr-3 text-[10px] text-cs2-text-primary outline-none placeholder:text-cs2-text-muted focus:border-cs2-accent" /></label>
            <div className="flex items-center gap-4 text-[8px] uppercase tracking-[0.1em] text-cs2-text-muted"><span className="inline-flex items-center gap-1.5"><Layers3 className="h-3.5 w-3.5 text-cs2-accent" />{t("cosmeticsWorkshop.catalog.baseFirst")}</span><span className="inline-flex items-center gap-1.5"><Rotate3D className="h-3.5 w-3.5 text-cs2-accent" />{t("cosmeticsWorkshop.catalog.inspectOnDemand")}</span></div>
          </div>

          <div className="mb-2.5 mt-3 flex items-center justify-between gap-3 px-0.5"><div className="flex items-center gap-2"><h2 className="text-[11px] font-black text-cs2-text-primary">{t("cosmeticsWorkshop.catalog.title")}</h2><span className="font-mono text-[9px] text-cs2-text-muted">{t("cosmeticsWorkshop.catalog.results", { count: filteredItems.length })}</span></div><span className="text-[8px] text-cs2-text-muted">{t("cosmeticsWorkshop.catalog.hint")}</span></div>

          {filteredItems.length ? (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 min-[1380px]:grid-cols-5 min-[1660px]:grid-cols-6">
              {filteredItems.map((item) => <BaseItemCard key={item.catalog_id} item={item} locale={locale} skinCount={SKIN_COUNT_BY_DEF.get(`${item.type}:${item.def_index}`) || 0} onClick={() => setSkinPicker({ mode: "browse", baseItem: item, currentItem: item })} />)}
            </div>
          ) : (
            <div className="flex min-h-[360px] flex-col items-center justify-center rounded-[10px] border border-dashed border-cs2-border bg-cs2-bg-card text-center"><Search className="h-6 w-6 text-cs2-text-muted" /><p className="mt-3 text-[11px] font-bold text-cs2-text-secondary">{t("cosmeticsWorkshop.catalog.empty")}</p><button type="button" onClick={() => setQuery("")} className="mt-2 text-[9px] font-semibold text-cs2-accent hover:underline">{t("cosmeticsWorkshop.catalog.reset")}</button></div>
          )}
        </section>
      </PageContainer>

      <SchemeManagerModal open={schemeOpen} plans={plans} setPlans={setPlans} locale={locale} onClose={() => setSchemeOpen(false)} onEditSlot={editSchemeSlot} />
      <SkinPickerModal state={skinPicker} locale={locale} onClose={() => setSkinPicker(null)} onInspect={setInspectItem} onConfirm={confirmSchemeSelection} />
      <InspectModal item={inspectItem} locale={locale} onClose={() => setInspectItem(null)} />
    </div>
  );
}
