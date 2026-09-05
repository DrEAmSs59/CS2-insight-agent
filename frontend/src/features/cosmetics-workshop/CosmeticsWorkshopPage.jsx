import { useEffect, useMemo, useState } from "react";
import {
  Box, Check, ChevronRight, CirclePlus, Crosshair, Dices, Gamepad2, Gem, Hand,
  Layers3, MousePointer2, Pencil, Plus, Rotate3D, Search, Shield, Sparkles,
  Sword, Trash2, X, ZoomIn,
} from "lucide-react";
import PageContainer from "../../components/PageContainer.jsx";
import Button from "../../components/ui/Button.jsx";
import Modal from "../../components/ui/Modal.jsx";
import { useLocaleStore } from "../../i18n/localeStore.js";
import { useT } from "../../i18n/useT.js";
import { CS2_COSMETICS_ITEMS } from "../../generated/cs2CosmeticsCatalog.js";
import { desktopBridge } from "../../desktop/desktopBridge.js";
import { buildCs2ViewerUrl, launchCs2Inspect } from "../../utils/cs2Inspect.js";
import { launchCs2InspectOnHost } from "../../api/cs2InspectApi.js";
import { readWorkshopScheme, writeWorkshopScheme } from "./workshopSchemeStorage.js";
import {
  candidateTypeGroupKey,
  craftNameParts,
  filterCandidates,
  formatCraftPipeName,
  imageUrlForWear,
  listCandidateTypeGroups,
  listDefaultLoadout,
  sortCandidatesByRarityDesc,
} from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

const IMAGE_BASE = "https://cdn.cstrike.app";
const TYPE_ORDER = ["melee", "glove", "weapon"];
const TYPE_META = {
  melee: { icon: Sword, labelKey: "cosmeticsWorkshop.type.melee" },
  glove: { icon: Hand, labelKey: "cosmeticsWorkshop.type.glove" },
  weapon: { icon: Crosshair, labelKey: "cosmeticsWorkshop.type.weapon" },
};
const CATEGORY_ORDER = ["secondary", "rifle", "smg", "heavy"];
const WEAPON_SUBCATEGORY_ORDER = ["all", "sniper", "rifle", "smg", "pistol", "shotgun", "machineGun", "other"];
const WEAPON_SUBCATEGORY_MODELS = {
  sniper: new Set(["awp", "g3sg1", "scar20", "ssg08"]),
  rifle: new Set(["ak47", "aug", "famas", "galilar", "m4a1", "m4a1_silencer", "sg556"]),
  smg: new Set(["bizon", "mac10", "mp5sd", "mp7", "mp9", "p90", "ump45"]),
  pistol: new Set(["cz75a", "deagle", "elite", "fiveseven", "glock", "hkp2000", "p250", "revolver", "tec9", "usp_silencer"]),
  shotgun: new Set(["mag7", "nova", "sawedoff", "xm1014"]),
  machineGun: new Set(["m249", "negev"]),
};

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

function skinDisplayName(item, locale) {
  const { model, finish, alt, full } = craftNameParts(item, locale);
  if (String(item?.type || "") === "melee") {
    return formatCraftPipeName(item, locale) || full;
  }
  const skinName = finish || model || full;
  return alt ? `${skinName}|${alt}` : skinName;
}

function defaultWear(item) {
  const min = Number(item?.wear_min ?? 0);
  const max = Number(item?.wear_max ?? 1);
  return Math.min(max, Math.max(min, 0.07));
}

function configuredWear(item) {
  const value = Number(item?.paint_wear);
  if (!Number.isFinite(value)) return defaultWear(item);
  const min = Number(item?.wear_min ?? 0);
  const max = Number(item?.wear_max ?? 1);
  return Math.min(max, Math.max(min, value));
}

function configuredSeed(item) {
  const value = Number(item?.paint_seed);
  return Number.isFinite(value) ? Math.min(1000, Math.max(0, Math.round(value))) : 0;
}

function previewImage(item, wear = defaultWear(item)) {
  return imageUrlForWear(item?.image_url, wear, item);
}

function supportsHosted3d(item) {
  return ["weapon", "melee"].includes(String(item?.type || "")) && !item?.is_base;
}

async function writeInspectClipboard(text) {
  if (desktopBridge?.writeClipboardText) {
    await desktopBridge.writeClipboardText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("Clipboard API unavailable");
}

function ItemImage({ item, wear, className = "" }) {
  const [failed, setFailed] = useState(false);
  const source = failed ? "" : previewImage(item, wear);
  useEffect(() => setFailed(false), [item?.catalog_id, wear]);
  if (!source) return <span className={`flex items-center justify-center text-cs2-text-muted ${className}`}><Box className="h-8 w-8 opacity-45" /></span>;
  return <img src={source} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} className={`object-contain ${className}`} />;
}

function weaponSubcategory(item) {
  const model = String(item?.model || "");
  return Object.entries(WEAPON_SUBCATEGORY_MODELS)
    .find(([, models]) => models.has(model))?.[0] || "other";
}

function CategoryButton({ type, active, onClick }) {
  const t = useT();
  const { icon: Icon, labelKey } = TYPE_META[type];
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={`group flex min-w-[150px] flex-1 items-center gap-3 rounded-[10px] border px-4 py-3 text-left transition-colors ${active ? "border-cs2-accent/55 bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-card text-cs2-text-secondary hover:border-cs2-accent/30 hover:bg-cs2-bg-hover"}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${active ? "border-cs2-accent/30 bg-cs2-bg-page/60" : "border-cs2-border-subtle bg-cs2-bg-input"}`}><Icon className="h-[18px] w-[18px]" /></span>
      <span className="min-w-0 flex-1 text-[12px] font-black">{t(labelKey)}</span>
      <ChevronRight className={`h-3.5 w-3.5 ${active ? "text-cs2-accent" : "opacity-30"}`} />
    </button>
  );
}

function WeaponSubcategoryFilter({ active, onChange }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-1 flex-nowrap gap-2 overflow-x-auto" aria-label={t("cosmeticsWorkshop.weaponCategory.label")}>
      {WEAPON_SUBCATEGORY_ORDER.map((category) => (
        <button
          key={category}
          type="button"
          aria-pressed={active === category}
          onClick={() => onChange(category)}
          className={`rounded-full border px-3 py-1.5 text-[10px] font-bold transition-colors ${active === category ? "border-cs2-accent bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-card text-cs2-text-secondary hover:border-cs2-text-muted hover:bg-cs2-bg-hover"}`}
        >
          {t(`cosmeticsWorkshop.weaponCategory.${category}`)}
        </button>
      ))}
    </div>
  );
}

function BaseItemCard({ item, locale, skinCount, compact = false, currentItem, onClick }) {
  const t = useT();
  const shown = currentItem || item;
  const parts = craftNameParts(shown, locale);
  const baseParts = craftNameParts(item, locale);
  return (
    <button type="button" onClick={onClick} aria-label={baseParts.model || localizedName(item, locale)} className={`group relative flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-cs2-border bg-cs2-bg-card text-left transition-all hover:-translate-y-0.5 hover:border-cs2-accent/40 hover:bg-cs2-bg-elevated ${compact ? "min-h-[170px]" : "min-h-[190px]"}`}>
      <div className={`cosmetic-preview-surface relative flex items-center justify-center overflow-hidden border-b border-cs2-border-subtle ${compact ? "h-[112px]" : "h-[138px]"}`} data-workshop-preview>
        <ItemImage item={shown} wear={shown?.paint_wear} className="h-full w-full p-2 transition-transform duration-200 group-hover:scale-[1.04]" />
        {!compact ? <span className="absolute bottom-2 right-2 rounded-[4px] border border-white/10 bg-black/45 px-2 py-1 font-mono text-[10px] font-bold text-white/85">{t("cosmeticsWorkshop.base.skinCount", { count: skinCount })}</span> : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0"><span className={`${compact ? "text-[12px]" : "text-[11px]"} block truncate font-bold text-cs2-text-primary`}>{parts.model}</span>{parts.finish ? <span className={`mt-1 block truncate font-semibold ${compact ? "text-[10px]" : "text-[9px]"}`} style={{ color: shown.rarity }}>{parts.finish}</span> : null}</div>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-cs2-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-cs2-accent" />
      </div>
    </button>
  );
}

function SkinCaption({ item, locale, originalLabel }) {
  if (originalLabel) {
    return <span className="block min-w-0 truncate font-semibold text-cs2-text-secondary">{originalLabel}</span>;
  }
  if (String(item?.type || "") !== "melee") {
    return <span className="block min-w-0 truncate font-semibold" style={{ color: String(item?.rarity || "").trim() || "#ded6cc" }}>{skinDisplayName(item, locale)}</span>;
  }
  const parts = craftNameParts(item, locale);
  const rarityColor = String(item?.rarity || "").trim() || "#ded6cc";
  const separator = <span className="text-cs2-text-muted"> | </span>;
  return (
    <span className="block min-w-0 break-words font-semibold leading-snug" title={formatCraftPipeName(item, locale)}>
      {parts.model ? <span className="text-cs2-text-secondary">{parts.model}</span> : null}
      {parts.finish ? <>{parts.model ? separator : null}<span style={{ color: rarityColor }}>{parts.finish}</span></> : null}
      {parts.alt ? <>{(parts.model || parts.finish) ? separator : null}<span style={{ color: rarityColor }}>{parts.alt}</span></> : null}
    </span>
  );
}

function SkinCard({
  item,
  locale,
  selected,
  selectionEnabled,
  showInspectActions,
  onSelect,
  onInspectInGame,
  onInspect3d,
}) {
  const t = useT();
  const original = Boolean(item?.is_base);
  const displayName = original ? t("cosmeticsWorkshop.base.original") : skinDisplayName(item, locale);
  const active = Boolean(selectionEnabled && selected);
  return (
    <article className={`cosmetic-preview-surface group relative flex min-h-[164px] min-w-0 flex-col overflow-hidden rounded-[10px] border transition-colors ${active ? "border-cs2-accent ring-1 ring-cs2-accent/30" : "border-cs2-border hover:border-cs2-text-muted"}`}>
      <button type="button" onClick={onSelect} aria-pressed={selectionEnabled ? active : undefined} aria-label={displayName} className="flex min-h-0 flex-1 flex-col text-left">
        <span className="relative flex aspect-[4/3] items-center justify-center" data-workshop-preview><ItemImage item={item} className="h-full w-full p-2 transition-transform group-hover:scale-[1.035]" />{active ? <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-cs2-accent text-white"><Check className="h-3 w-3" /></span> : null}</span>
        <span className="mt-auto block min-h-[32px] min-w-0 border-t border-cs2-border bg-cs2-bg-card px-2.5 py-2 text-[10px]"><SkinCaption item={item} locale={locale} originalLabel={original ? displayName : ""} /></span>
      </button>
      {!original && showInspectActions ? (
        <div className="grid h-8 grid-cols-2 border-t border-cs2-border bg-cs2-bg-input/85">
          <button type="button" onClick={onInspectInGame} className="inline-flex items-center justify-center gap-1 border-r border-cs2-border text-[8px] font-bold text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-accent"><Gamepad2 className="h-3 w-3" />{t("analysis.cosmetics.inspectInGame")}</button>
          <button type="button" onClick={onInspect3d} className="inline-flex items-center justify-center gap-1 text-[8px] font-bold text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-accent"><Rotate3D className="h-3 w-3" />{t("analysis.cosmetics.inspect3d")}</button>
        </div>
      ) : null}
    </article>
  );
}

function ParamControl({ label, value, min, max, step, editable = false, onChange, onRandom }) {
  const progress = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center justify-between gap-3 text-[9px] font-semibold text-cs2-text-muted"><span>{label}</span>{editable ? <input type="number" aria-label={label} min={min} max={max} step={step} value={step < 1 ? Number(value).toFixed(6) : Math.round(value)} onChange={(event) => { const parsed = Number(event.target.value); if (!Number.isFinite(parsed)) return; const clamped = Math.min(max, Math.max(min, parsed)); onChange(step >= 1 ? Math.round(clamped) : clamped); }} className="h-7 w-24 rounded-md border border-cs2-border bg-cs2-bg-input px-2 text-right font-mono text-[9px] text-cs2-text-secondary outline-none focus:border-cs2-accent" /> : <output className="font-mono text-cs2-text-secondary">{step < 1 ? Number(value).toFixed(6) : Math.round(value)}</output>}</span>
      <span className="flex items-center gap-2"><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="cs2-data-slider min-w-0 flex-1" style={{ "--cs2-range-progress": `${progress}%` }} /><button type="button" onClick={onRandom} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cs2-border bg-cs2-bg-input text-cs2-text-muted hover:text-cs2-accent"><Dices className="h-3.5 w-3.5" /></button></span>
    </label>
  );
}

function SchemeSkinConfigPanel({
  item,
  locale,
  wear,
  seed,
  inspectBusy,
  inspectFeedback,
  onWearChange,
  onSeedChange,
  onInspectInGame,
  onInspect3d,
  onApply,
}) {
  const t = useT();
  const original = Boolean(item?.is_base);
  const wearMin = Number(item?.wear_min ?? 0);
  const wearMax = Number(item?.wear_max ?? 1);
  return (
    <aside className="flex w-[300px] shrink-0 flex-col rounded-[10px] border border-cs2-border bg-cs2-bg-input/45 p-3" data-testid="scheme-skin-config">
      <div className="shrink-0"><h3 className="text-[12px] font-black text-cs2-text-primary">{t("cosmeticsWorkshop.scheme.configure")}</h3><p className="mt-1 text-[9px] leading-relaxed text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.configureHint")}</p></div>
      <div className="cosmetic-preview-surface mt-3 flex aspect-[4/3] shrink-0 items-center justify-center rounded-lg border border-cs2-border" data-workshop-preview><ItemImage item={item} wear={wear} className="h-full w-full p-2" /></div>
      <div className="mt-2 text-[10px] font-bold leading-snug text-cs2-text-secondary">{original ? t("cosmeticsWorkshop.base.original") : skinDisplayName(item, locale)}</div>
      {!original ? (
        <div className="mt-4 space-y-4">
          <ParamControl label={t("analysis.cosmetics.picker.wear")} value={wear} min={wearMin} max={wearMax} step={0.000001} editable onChange={onWearChange} onRandom={() => onWearChange(wearMin + Math.random() * (wearMax - wearMin))} />
          <ParamControl label={t("cosmeticsWorkshop.scheme.patternSeed")} value={seed} min={0} max={1000} step={1} editable onChange={onSeedChange} onRandom={() => onSeedChange(Math.floor(Math.random() * 1001))} />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="sm" disabled={inspectBusy} onClick={onInspectInGame} className="min-w-0 px-2"><Gamepad2 className="h-3.5 w-3.5" />{t("analysis.cosmetics.inspectInGame")}</Button>
            <Button variant="secondary" size="sm" onClick={onInspect3d} className="min-w-0 px-2"><Rotate3D className="h-3.5 w-3.5" />{t("analysis.cosmetics.inspect3d")}</Button>
          </div>
          {inspectFeedback ? <p role={inspectFeedback.tone === "error" ? "alert" : undefined} className={`text-[9px] leading-relaxed ${inspectFeedback.tone === "error" ? "text-rose-300" : "text-emerald-300"}`}>{inspectFeedback.text}</p> : null}
        </div>
      ) : null}
      <Button size="sm" onClick={onApply} className="mt-auto w-full"><Check className="h-3.5 w-3.5" />{t("cosmeticsWorkshop.skin.confirm")}</Button>
    </aside>
  );
}

function InspectModal({ item, locale, onClose }) {
  const t = useT();
  const [wear, setWear] = useState(() => configuredWear(item));
  const [seed, setSeed] = useState(() => configuredSeed(item));
  const viewerUrl = supportsHosted3d(item) ? buildCs2ViewerUrl({ ...item, paint_wear: wear, paint_seed: seed }) : "";
  useEffect(() => { setWear(configuredWear(item)); setSeed(configuredSeed(item)); }, [item]);
  return (
    <Modal open={Boolean(item)} onClose={onClose} title={t("cosmeticsWorkshop.inspect.title")} subtitle={item ? skinDisplayName(item, locale) : ""} icon={<Rotate3D className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-[920px]" maxHeight="max-h-[86vh]" className="!h-auto" contentClassName="overflow-y-auto" zIndex={120} footer={<div className="flex justify-end"><Button variant="secondary" size="sm" onClick={onClose}>{t("common.close")}</Button></div>}>
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

function GameInspectModal({ item, locale, busy, feedback, onClose, onLaunch }) {
  const t = useT();
  const [wear, setWear] = useState(() => configuredWear(item));
  const [seed, setSeed] = useState(() => configuredSeed(item));
  useEffect(() => {
    setWear(configuredWear(item));
    setSeed(configuredSeed(item));
  }, [item]);
  const previewItem = item ? { ...item, paint_wear: wear, paint_seed: seed } : null;
  return (
    <Modal
      open={Boolean(item)}
      onClose={onClose}
      title={t("analysis.cosmetics.inspectInGame")}
      subtitle={item ? skinDisplayName(item, locale) : ""}
      icon={<Gamepad2 className="h-4 w-4 text-cs2-accent" />}
      maxWidth="max-w-[560px]"
      className="!h-auto"
      contentClassName="overflow-y-auto"
      zIndex={130}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" disabled={busy || !previewItem} onClick={() => onLaunch(previewItem)}><Gamepad2 className="h-3.5 w-3.5" />{t("analysis.cosmetics.inspectInGame")}</Button>
        </div>
      )}
    >
      <div className="p-4">
        <div className="cosmetic-preview-surface flex h-[240px] items-center justify-center rounded-[10px] border border-cs2-border" data-workshop-preview>
          <ItemImage item={previewItem} wear={wear} className="h-full w-full p-4" />
        </div>
        <div className="mt-3 grid gap-4 rounded-[10px] border border-cs2-border bg-cs2-bg-input/40 p-3 sm:grid-cols-2">
          <ParamControl label={t("analysis.cosmetics.picker.wear")} value={wear} min={item?.wear_min ?? 0} max={item?.wear_max ?? 1} step={0.000001} editable onChange={setWear} onRandom={() => setWear((item?.wear_min ?? 0) + Math.random() * ((item?.wear_max ?? 1) - (item?.wear_min ?? 0)))} />
          <ParamControl label={t("analysis.cosmetics.picker.seed")} value={seed} min={0} max={1000} step={1} editable onChange={setSeed} onRandom={() => setSeed(Math.floor(Math.random() * 1001))} />
        </div>
        <p className="mt-3 text-[9px] leading-relaxed text-cs2-text-muted">{t("cosmeticsWorkshop.inspect.gameHint")}</p>
        {feedback ? <div role={feedback.tone === "error" ? "alert" : "status"} className={`mt-3 rounded-md border px-3 py-2 text-[10px] ${feedback.tone === "error" ? "border-rose-500/35 bg-rose-500/10 text-rose-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}>{feedback.text}</div> : null}
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

function SkinPickerModal({
  state,
  locale,
  inspectBusy,
  inspectFeedback,
  onClose,
  onOpenGameInspect,
  onLaunchGameInspect,
  onInspect3d,
  onConfirm,
}) {
  const t = useT();
  const baseItem = state?.baseItem;
  const schemeMode = state?.mode === "scheme";
  const [query, setQuery] = useState("");
  const [activeTypeGroup, setActiveTypeGroup] = useState("");
  const [selected, setSelected] = useState(null);
  const [draftItem, setDraftItem] = useState(null);
  const [draftWear, setDraftWear] = useState(0.07);
  const [draftSeed, setDraftSeed] = useState(0);
  const candidates = useMemo(() => skinCandidatesFor(baseItem, schemeMode), [baseItem, schemeMode]);
  const typeGroups = useMemo(() => (
    schemeMode && ["melee", "glove"].includes(String(baseItem?.type || ""))
      ? listCandidateTypeGroups(candidates, locale)
      : []
  ), [baseItem?.type, candidates, locale, schemeMode]);
  const defaultTypeGroup = useMemo(() => {
    if (typeGroups.length <= 1) return "";
    const currentGroup = candidateTypeGroupKey(state?.currentItem || baseItem);
    return typeGroups.some((group) => group.key === currentGroup)
      ? currentGroup
      : typeGroups[0]?.key || "";
  }, [baseItem, state?.currentItem, typeGroups]);
  useEffect(() => {
    if (!state) return;
    setQuery("");
    setActiveTypeGroup(defaultTypeGroup);
    setSelected(state.currentItem || baseItem);
    setDraftItem(null);
  }, [baseItem, defaultTypeGroup, state]);
  const filtered = useMemo(
    () => filterCandidates(candidates, query, locale, activeTypeGroup),
    [activeTypeGroup, candidates, locale, query],
  );
  const allItems = useMemo(() => {
    const baseMatchesType = !activeTypeGroup || candidateTypeGroupKey(baseItem) === activeTypeGroup;
    const rows = schemeMode ? [...(baseMatchesType ? [baseItem] : []), ...filtered] : filtered;
    const currentItem = state?.currentItem;
    if (!schemeMode || !currentItem) return rows;
    return rows.map((item) => (
      Number(item.catalog_id) === Number(currentItem.catalog_id)
        && Number(item.paint_index) === Number(currentItem.paint_index)
        ? currentItem
        : item
    ));
  }, [activeTypeGroup, baseItem, filtered, schemeMode, state?.currentItem]);

  const openSchemeConfig = (item) => {
    setSelected(item);
    setDraftItem(item);
    setDraftWear(configuredWear(item));
    setDraftSeed(configuredSeed(item));
  };

  const applySchemeConfig = () => {
    if (!draftItem) return;
    onConfirm(draftItem.is_base ? draftItem : {
      ...draftItem,
      paint_wear: draftWear,
      paint_seed: draftSeed,
    });
  };
  return (
    <Modal open={Boolean(state)} onClose={onClose} title={baseItem ? t("cosmeticsWorkshop.skin.title", { name: craftNameParts(baseItem, locale).model || localizedName(baseItem, locale) }) : ""} subtitle={<span className="text-[12px] font-medium leading-relaxed">{t(schemeMode ? "cosmeticsWorkshop.skin.schemeSubtitle" : "cosmeticsWorkshop.skin.browseSubtitle", { count: candidates.length })}</span>} icon={<Sparkles className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-[1180px]" maxHeight="max-h-[90vh]" contentClassName="min-h-0 flex-1 overflow-hidden" zIndex={110}>
      <div className="flex h-full min-h-0 gap-3 overflow-hidden p-4">
        <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {typeGroups.length > 1 ? (
            <div className="mb-3 shrink-0">
              <div className="mb-2 text-[9px] font-bold text-cs2-text-muted">{t(baseItem?.type === "glove" ? "analysis.cosmetics.picker.gloveTypes" : "analysis.cosmetics.picker.knifeTypes")}</div>
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1" aria-label={t(baseItem?.type === "glove" ? "analysis.cosmetics.picker.gloveTypes" : "analysis.cosmetics.picker.knifeTypes")}>
                <button type="button" aria-pressed={!activeTypeGroup} onClick={() => { setActiveTypeGroup(""); setDraftItem(null); }} className={`rounded-md border px-2.5 py-1.5 text-[9px] font-bold transition-colors ${!activeTypeGroup ? "border-cs2-accent bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-card text-cs2-text-secondary hover:border-cs2-text-muted"}`}>{t("analysis.cosmetics.picker.allTypes")} · {candidates.length}</button>
                {typeGroups.map((group) => <button key={group.key} type="button" aria-pressed={activeTypeGroup === group.key} onClick={() => { setActiveTypeGroup(group.key); setDraftItem(null); }} className={`rounded-md border px-2.5 py-1.5 text-[9px] font-bold transition-colors ${activeTypeGroup === group.key ? "border-cs2-accent bg-cs2-accent-soft text-cs2-accent" : "border-cs2-border bg-cs2-bg-card text-cs2-text-secondary hover:border-cs2-text-muted"}`}>{group.label} · {group.count}</button>)}
              </div>
            </div>
          ) : null}
          <label className="relative mb-3 block shrink-0"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cs2-text-muted" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("cosmeticsWorkshop.skin.search")} className="h-9 w-full rounded-md border border-cs2-border bg-cs2-bg-input pl-9 pr-3 text-[10px] text-cs2-text-primary outline-none placeholder:text-cs2-text-muted focus:border-cs2-accent" /></label>
          <div className={`grid min-h-0 flex-1 auto-rows-min content-start gap-2.5 overflow-y-auto pr-1 ${schemeMode && draftItem ? "grid-cols-2 sm:grid-cols-3 xl:grid-cols-4" : "grid-cols-3 sm:grid-cols-4 xl:grid-cols-5"}`} data-testid="workshop-skin-list">{allItems.map((item) => <SkinCard key={`${item.catalog_id}-${item.paint_index}`} item={item} locale={locale} selected={selected?.catalog_id === item.catalog_id && selected?.paint_index === item.paint_index} selectionEnabled={schemeMode} showInspectActions={!schemeMode} onSelect={() => (schemeMode ? openSchemeConfig(item) : setSelected(item))} onInspectInGame={() => onOpenGameInspect(item)} onInspect3d={() => onInspect3d(item)} />)}</div>
        </section>
        {schemeMode && draftItem ? <SchemeSkinConfigPanel item={draftItem} locale={locale} wear={draftWear} seed={draftSeed} inspectBusy={inspectBusy} inspectFeedback={inspectFeedback} onWearChange={setDraftWear} onSeedChange={setDraftSeed} onInspectInGame={() => onLaunchGameInspect({ ...draftItem, paint_wear: draftWear, paint_seed: draftSeed })} onInspect3d={() => onInspect3d({ ...draftItem, paint_wear: draftWear, paint_seed: draftSeed })} onApply={applySchemeConfig} /> : null}
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

function SchemeManagerModal({ open, plans, setPlans, locale, onClose, onEditSlot, onSave }) {
  const t = useT();
  const [team, setTeam] = useState("ct");
  const [notice, setNotice] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const plan = plans[0] || null;
  const groups = groupLoadout(TEAM_LOADOUTS[team]);

  useEffect(() => {
    if (open) setNotice("");
  }, [open, plan]);

  useEffect(() => {
    if (!open) return;
    setEditingName(false);
    setNameDraft(plan?.name || "");
  }, [open, plan?.id]);

  const addPlan = () => {
    if (plans.length) return;
    setPlans([{ id: "plan-1", name: t("cosmeticsWorkshop.scheme.defaultName"), selections: { ct: {}, t: {} } }]);
  };

  const deletePlan = () => {
    setPlans([]);
    setNotice("");
  };

  const savePlan = () => {
    setNotice(t(onSave() ? "cosmeticsWorkshop.scheme.saved" : "cosmeticsWorkshop.scheme.saveFailed"));
  };

  const commitPlanName = () => {
    const nextName = nameDraft.trim();
    if (!nextName || !plan) return;
    setPlans((current) => current.map((item) => (item.id === plan.id ? { ...item, name: nextName } : item)));
    setEditingName(false);
    setNotice("");
  };

  const cancelPlanName = () => {
    setNameDraft(plan?.name || "");
    setEditingName(false);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("cosmeticsWorkshop.scheme.title")}
      subtitle={t("cosmeticsWorkshop.scheme.subtitle")}
      maxWidth="max-w-[1280px]"
      maxHeight="max-h-[92vh]"
      contentClassName="min-h-0 flex-1 overflow-hidden"
      footer={plan ? (
        <div className="flex justify-end">
          <Button variant={notice ? "primary" : "secondary"} size="sm" aria-live="polite" onClick={savePlan}>{notice ? <Check className="h-3.5 w-3.5" /> : null}{notice || t("cosmeticsWorkshop.scheme.save")}</Button>
        </div>
      ) : null}
    >
      <div className="grid h-full min-h-0 grid-cols-[190px_minmax(0,1fr)] overflow-hidden max-[760px]:grid-cols-1" data-testid="scheme-layout">
        <aside className="flex min-h-0 flex-col border-r border-cs2-border bg-cs2-bg-input/35 p-2.5 max-[760px]:border-b max-[760px]:border-r-0">
          <div className="flex items-center justify-between gap-2"><span className="text-[9px] font-black uppercase tracking-[0.12em] text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.list")}</span><span className="font-mono text-[8px] text-cs2-text-muted">{plans.length}/1</span></div>
          <button type="button" onClick={addPlan} disabled={plans.length >= 1} className="mt-3 flex h-9 items-center justify-center gap-1.5 rounded-lg border border-dashed border-cs2-accent/45 bg-cs2-accent-soft text-[9px] font-bold text-cs2-accent hover:border-cs2-accent disabled:cursor-not-allowed disabled:border-cs2-border disabled:bg-transparent disabled:text-cs2-text-muted disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{t("cosmeticsWorkshop.scheme.create")}</button>
          {plan ? (
            <div className="mt-3 rounded-[10px] border border-cs2-accent/50 bg-cs2-bg-card p-2.5 shadow-sm" data-testid="scheme-plan-card">
              <div className="flex items-center justify-between gap-2"><h3 className="min-w-0 truncate text-[11px] font-black text-cs2-text-primary">{plan.name}</h3><button type="button" onClick={deletePlan} aria-label={t("cosmeticsWorkshop.scheme.delete")} className="shrink-0 rounded-md p-1.5 text-cs2-text-muted hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button></div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center py-8 text-center"><CirclePlus className="h-7 w-7 text-cs2-text-muted opacity-50" /><p className="mt-3 text-[10px] font-bold text-cs2-text-secondary">{t("cosmeticsWorkshop.scheme.empty")}</p><p className="mt-1 max-w-[170px] text-[8px] leading-relaxed text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.emptyHint")}</p></div>
          )}
          <p className="mt-auto rounded-lg border border-cs2-border-subtle bg-cs2-bg-card/70 p-2 text-[8px] leading-relaxed text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.limitHint")}</p>
        </aside>

        {plan ? (
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden p-4">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-cs2-border-subtle pb-3">
              <div className="min-w-0">
                {editingName ? (
                  <form className="flex items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); commitPlanName(); }}>
                    <input autoFocus type="text" maxLength={40} aria-label={t("cosmeticsWorkshop.scheme.nameLabel")} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelPlanName(); } }} className="h-8 w-[240px] max-w-[50vw] rounded-md border border-cs2-accent bg-cs2-bg-input px-2.5 text-[12px] font-bold text-cs2-text-primary outline-none" />
                    <button type="submit" disabled={!nameDraft.trim()} aria-label={t("common.save")} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-accent/50 bg-cs2-accent-soft text-cs2-accent disabled:opacity-40"><Check className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={cancelPlanName} aria-label={t("common.cancel")} className="flex h-8 w-8 items-center justify-center rounded-md border border-cs2-border bg-cs2-bg-input text-cs2-text-muted hover:text-cs2-text-primary"><X className="h-3.5 w-3.5" /></button>
                  </form>
                ) : (
                  <div className="flex min-w-0 items-center gap-1.5"><h3 className="truncate text-[13px] font-black text-cs2-text-primary">{plan.name}</h3><button type="button" onClick={() => { setNameDraft(plan.name); setEditingName(true); }} aria-label={t("cosmeticsWorkshop.scheme.rename")} className="shrink-0 rounded-md p-1.5 text-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-accent"><Pencil className="h-3.5 w-3.5" /></button></div>
                )}
                <p className="mt-0.5 text-[8px] text-cs2-text-muted">{t("cosmeticsWorkshop.scheme.editHint")}</p>
              </div>
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
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
  const [activeWeaponCategory, setActiveWeaponCategory] = useState("all");
  const [skinPicker, setSkinPicker] = useState(null);
  const [inspectItem, setInspectItem] = useState(null);
  const [gameInspectItem, setGameInspectItem] = useState(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectFeedback, setInspectFeedback] = useState(null);
  const [schemeOpen, setSchemeOpen] = useState(false);
  const [plans, setPlans] = useState(() => {
    const fallback = [{ id: "plan-1", name: t("cosmeticsWorkshop.scheme.defaultName"), selections: { ct: {}, t: {} } }];
    const savedPlan = readWorkshopScheme();
    if (!savedPlan) return fallback;
    return [{
      ...savedPlan,
      id: "plan-1",
      name: String(savedPlan.name || t("cosmeticsWorkshop.scheme.defaultName")),
    }];
  });

  const filteredItems = useMemo(() => {
    return CATALOG_BASE_ITEMS
      .filter((item) => item.type === activeType)
      .filter((item) => activeType !== "weapon" || activeWeaponCategory === "all" || weaponSubcategory(item) === activeWeaponCategory)
      .sort((left, right) => localizedName(left, locale).localeCompare(localizedName(right, locale)));
  }, [activeType, activeWeaponCategory, locale]);

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

  const saveScheme = () => {
    return writeWorkshopScheme(plans[0]);
  };

  const openGameInspect = (item) => {
    setInspectFeedback(null);
    setGameInspectItem(item);
  };

  const inspectInGame = async (item) => {
    setInspectBusy(true);
    setInspectFeedback(null);
    try {
      const result = await launchCs2Inspect(item, {
        launchInspect: launchCs2InspectOnHost,
        openExternal: desktopBridge?.openExternal,
        writeClipboardText: writeInspectClipboard,
      });
      const messageKey = result.status === "launched"
        ? "analysis.cosmetics.inspectLaunched"
        : "analysis.cosmetics.inspectCommandCopied";
      setInspectFeedback({ tone: "success", text: t(messageKey) });
    } catch (error) {
      console.warn("Failed to launch CS2 inspect", error);
      setInspectFeedback({ tone: "error", text: t("analysis.cosmetics.inspectFailed") });
    } finally {
      setInspectBusy(false);
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-cs2-bg-page">
      <PageContainer className="!h-auto min-h-full !max-w-[1720px] pb-10">
        <header className="flex flex-col gap-4 border-b border-cs2-border-subtle pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent"><Gem className="h-[18px] w-[18px]" /></span><div><h1 className="text-xl font-black tracking-tight text-cs2-text-primary">{t("cosmeticsWorkshop.title")}</h1><p className="mt-0.5 text-[10px] text-cs2-text-muted">{t("cosmeticsWorkshop.subtitle")}</p></div></div></div>
          <Button size="md" onClick={() => setSchemeOpen(true)} className="shrink-0"><Gem className="h-4 w-4" />{t("cosmeticsWorkshop.scheme.button")}<span className="rounded bg-black/20 px-1.5 py-0.5 font-mono text-[8px]">{plans.length}/1</span></Button>
        </header>

        <div className="mt-4 flex flex-wrap gap-2" aria-label={t("cosmeticsWorkshop.categories")}>
          {TYPE_ORDER.map((type) => <CategoryButton key={type} type={type} active={activeType === type} onClick={() => { setActiveType(type); if (type === "weapon") setActiveWeaponCategory("all"); }} />)}
        </div>
        {activeType === "weapon" ? (
          <div className="mt-3 flex min-w-0 items-center justify-between gap-4 px-0.5">
            <WeaponSubcategoryFilter active={activeWeaponCategory} onChange={setActiveWeaponCategory} />
            <span className="shrink-0 text-[11px] font-medium text-cs2-text-secondary">{t("cosmeticsWorkshop.catalog.hint")}</span>
          </div>
        ) : null}

        <section className="mt-3 min-w-0">
          {activeType !== "weapon" ? <div className="mb-2.5 flex justify-end px-0.5"><span className="text-[11px] font-medium text-cs2-text-secondary">{t("cosmeticsWorkshop.catalog.hint")}</span></div> : null}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 min-[1380px]:grid-cols-5 min-[1660px]:grid-cols-6">
            {filteredItems.map((item) => <BaseItemCard key={item.catalog_id} item={item} locale={locale} skinCount={SKIN_COUNT_BY_DEF.get(`${item.type}:${item.def_index}`) || 0} onClick={() => setSkinPicker({ mode: "browse", baseItem: item, currentItem: item })} />)}
          </div>
        </section>
      </PageContainer>

      <SchemeManagerModal open={schemeOpen} plans={plans} setPlans={setPlans} locale={locale} onClose={() => setSchemeOpen(false)} onEditSlot={editSchemeSlot} onSave={saveScheme} />
      <SkinPickerModal state={skinPicker} locale={locale} inspectBusy={inspectBusy} inspectFeedback={inspectFeedback} onClose={() => setSkinPicker(null)} onOpenGameInspect={openGameInspect} onLaunchGameInspect={(item) => void inspectInGame(item)} onInspect3d={(item) => { setInspectFeedback(null); setInspectItem(item); }} onConfirm={confirmSchemeSelection} />
      <InspectModal item={inspectItem} locale={locale} onClose={() => setInspectItem(null)} />
      <GameInspectModal item={gameInspectItem} locale={locale} busy={inspectBusy} feedback={inspectFeedback} onClose={() => { setGameInspectItem(null); setInspectFeedback(null); }} onLaunch={(item) => void inspectInGame(item)} />
    </div>
  );
}
