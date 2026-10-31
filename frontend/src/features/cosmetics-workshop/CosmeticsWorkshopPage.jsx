import CosmeticInspectActions from "./CosmeticInspectActions.jsx";
import { CS2Team } from "@ianlucas/cs2-lib";
import { useWorkshopLoadoutSelection } from "./workshopLoadoutSelection.js";
import { LucasCategoryFilter, LucasItemTile, LucasToolSelect } from "./LucasWorkshop.jsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Layers3, MousePointer2, Rotate3D, ZoomIn } from "lucide-react";
import Button from "../../components/ui/Button.jsx";
import Modal from "../../components/ui/Modal.jsx";
import { useLocaleStore } from "../../i18n/localeStore.js";
import { useT } from "../../i18n/useT.js";
import { desktopBridge } from "../../desktop/desktopBridge.js";
import { buildCs2ViewerUrl, launchCs2Inspect } from "../../utils/cs2Inspect.js";
import { launchCs2InspectOnHost } from "../../api/cs2InspectApi.js";
import LucasItemEditorModal from "./LucasItemEditorModal.jsx";
import LucasIcon from "./LucasIcon.jsx";
import LucasWorkshopBackground from "./LucasWorkshopBackground.jsx";
import WorkshopItemImage, { defaultWear } from "./WorkshopItemImage.jsx";
import WorkshopItemPicker from "./WorkshopItemPicker.jsx";
import { editorDraft } from "./itemAppearance.js";
import WorkshopSchemeView, { emptyScheme } from "./WorkshopSchemeView.jsx";
import { readWorkshopScheme, readWorkshopSchemes, writeWorkshopSchemes } from "./workshopSchemeStorage.js";
import {
  ALL_BASE_ITEMS, ALL_SKINS, CATALOG_SORTS, CATEGORY_LABELS, FINISH_TYPES, TEAM_KEYS, WORKSHOP_CATEGORIES,
  catalogFilterOptions, catalogItems, catalogModels, itemTeams, localizedName, matchesCatalogFilter, modelFinishes,
  modelSkinCount, modelSkins, sortCatalogSkins, withSchemeSelection,
} from "./workshopCatalog.js";
import { craftNameParts, filterCandidates, isVanillaKnife } from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

const PAGE_SIZE = 120;
const SCHEME_LIMIT = 1;

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

function supportsHosted3d(item) {
  return ["weapon", "melee"].includes(String(item?.type || "")) && (!item?.is_base || isVanillaKnife(item));
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

function ParamControl({ label, value, min, max, step, onChange, onRandom }) {
  const progress = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex items-center justify-between gap-3 text-[9px] font-semibold text-cs2-text-muted"><span>{label}</span><output className="font-mono text-cs2-text-secondary">{step < 1 ? Number(value).toFixed(6) : Math.round(value)}</output></span>
      <span className="flex items-center gap-2"><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="cs2-data-slider min-w-0 flex-1" style={{ "--cs2-range-progress": `${progress}%` }} /><button type="button" onClick={onRandom} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cs2-border bg-cs2-bg-input text-cs2-text-muted hover:text-cs2-accent"><LucasIcon name="shuffle" size={12} /></button></span>
    </label>
  );
}

/** Free edition 3D preview through the hosted viewer. */
function InspectModal({ item, locale, onClose }) {
  const t = useT();
  const [wear, setWear] = useState(() => configuredWear(item));
  const [seed, setSeed] = useState(() => configuredSeed(item));
  const viewerUrl = supportsHosted3d(item) ? buildCs2ViewerUrl({ ...item, paint_wear: wear, paint_seed: seed }) : "";
  useEffect(() => { setWear(configuredWear(item)); setSeed(configuredSeed(item)); }, [item]);
  return (
    <Modal open={Boolean(item)} onClose={onClose} title={t("cosmeticsWorkshop.inspect.title")} subtitle={item ? localizedName(item, locale) : ""} icon={<Rotate3D className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-[920px]" maxHeight="max-h-[86vh]" className="!h-auto" contentClassName="overflow-y-auto" zIndex={120} footer={<div className="flex justify-end"><Button variant="secondary" size="sm" onClick={onClose}>{t("common.close")}</Button></div>}>
      <div className="p-4">
        <div className="cosmetic-preview-surface relative h-[min(540px,58vh)] overflow-hidden rounded-[10px] border border-cs2-border">
          {viewerUrl ? <iframe title={t("cosmeticsWorkshop.inspect.title")} src={viewerUrl} allow="fullscreen" className="h-full w-full border-0 bg-transparent" /> : <div className="flex h-full flex-col items-center justify-center p-8 text-center"><WorkshopItemImage item={item} wear={wear} className="h-[260px] w-full" /><p className="mt-3 max-w-md text-[11px] leading-relaxed text-white/65">{t("cosmeticsWorkshop.inspect.gloveFallback")}</p></div>}
        </div>
        <div className="mt-3 grid gap-3 rounded-[10px] border border-cs2-border bg-cs2-bg-input/40 p-3 sm:grid-cols-2"><ParamControl label={t("analysis.cosmetics.picker.wear")} value={wear} min={item?.wear_min ?? 0} max={item?.wear_max ?? 1} step={0.000001} onChange={setWear} onRandom={() => setWear((item?.wear_min ?? 0) + Math.random() * ((item?.wear_max ?? 1) - (item?.wear_min ?? 0)))} /><ParamControl label={t("analysis.cosmetics.picker.seed")} value={seed} min={0} max={1000} step={1} onChange={setSeed} onRandom={() => setSeed(Math.floor(Math.random() * 1001))} /></div>
        {viewerUrl ? <div className="mt-2 flex justify-end gap-3 text-[10px] text-cs2-text-muted"><span className="inline-flex items-center gap-1"><MousePointer2 className="h-3 w-3" />{t("cosmeticsWorkshop.inspect.rotate")}</span><span className="inline-flex items-center gap-1"><ZoomIn className="h-3 w-3" />{t("cosmeticsWorkshop.inspect.zoom")}</span></div> : null}
      </div>
    </Modal>
  );
}

function workshopPlanRecord(plan, index, fallbackName) {
  return {
    ...plan,
    id: String(plan?.id || `plan-${index + 1}`),
    name: String(plan?.name || fallbackName),
    selections: {
      ct: plan?.selections?.ct && typeof plan.selections.ct === "object" ? plan.selections.ct : {},
      t: plan?.selections?.t && typeof plan.selections.t === "object" ? plan.selections.t : {},
    },
  };
}

function initialWorkshopPlans(fallbackName) {
  const savedPlan = readWorkshopScheme();
  return savedPlan ? [workshopPlanRecord(savedPlan, 0, fallbackName)] : [];
}

/** Stock agents, music kits, knives and gloves reset the slot without opening an editor. */
function savesWithoutEditor(item) {
  if (!item.is_base) return false;
  return !FINISH_TYPES.includes(item.type) || modelFinishes(item).length === 1;
}

function teamLabel(team) {
  return TEAM_KEYS[team].toUpperCase();
}

const SORT_LABELS = { newest: ["最新添加", "Newest first"], name: ["名称", "Name"], rarity: ["品质", "Rarity"] };

/** A gun, knife or glove model; opening it lists all of its finishes. */
function ModelTile({ item, en, locale, onOpen }) {
  const name = localizedName(item, locale);
  const count = modelSkinCount(item);
  return <LucasItemTile label={name} model={name} finish={en ? `${count} finishes` : `${count} 款皮肤`} rarity={item.rarity}
    image={<WorkshopItemImage catalogOnly item={item} className="h-full w-full" />} onClick={() => onOpen(item)} />;
}

/** Finishes are browsed and inspected here; schemes are edited under Item schemes. */
function CatalogTile({ item, locale, inspectBusy, onEquip, onInspect3d, onInspectInGame, onCopy }) {
  const en = locale === "en";
  const finishType = FINISH_TYPES.includes(item.type);
  const parts = craftNameParts(item, locale);
  const model = finishType ? parts.model : null;
  const finish = finishType ? [parts.finish, parts.alt].filter(Boolean).join(" · ") : localizedName(item, locale);
  const preview = { ...item, paint_wear: defaultWear(item), paint_seed: 0 };
  const can3d = supportsHosted3d(preview);
  const teams = itemTeams(item);
  return <LucasItemTile label={[model, finish].filter(Boolean).join(" | ") || localizedName(item, locale)}
    model={model} finish={finish} rarity={item.rarity}
    image={<WorkshopItemImage catalogOnly item={item} className="h-full w-full" />}>
    {finishType ? null : item.type === "musickit"
      ? <button type="button" onClick={() => onEquip(item, teams)}>{en ? "Equip to scheme" : "装备到方案"}</button>
      : teams.map((team) => <button key={team} type="button" onClick={() => onEquip(item, [team])}>{en ? "Equip to" : "装备到"} {teamLabel(team)}</button>)}
    {can3d ? <button type="button" onClick={() => onInspect3d(preview)}>{en ? "3D inspect" : "3D 检视"}</button> : null}
    {finishType ? <CosmeticInspectActions item={preview} locale={locale} busy={inspectBusy} onInspectInGame={onInspectInGame} onCopy={onCopy} /> : null}
  </LucasItemTile>;
}

export default function CosmeticsWorkshopPage() {
  const t = useT();
  const locale = useLocaleStore((state) => state.effectiveLocale);
  const en = locale === "en";
  const [view, setView] = useState("scheme");
  const [category, setCategory] = useState("weapon");
  const [filter, setFilter] = useState("all");
  const [model, setModel] = useState(null);
  const [sort, setSort] = useState("newest");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [plans, setPlans] = useState(() => initialWorkshopPlans(t("cosmeticsWorkshop.scheme.defaultName")));
  const [selection, setSelection] = useWorkshopLoadoutSelection(plans);
  const [picker, setPicker] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");
  const [inspectItem, setInspectItemState] = useState(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const loadMore = useRef(null);
  const scroller = useRef(null);
  const modelListScroll = useRef(0);
  const schemeListScroll = useRef(0);
  const browsingItems = Boolean(picker);
  // Saves can follow a scheme created in the same handler, before state re-renders.
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const currentPlan = plans.find((plan) => plan.id === selection.selectedId) || null;

  // Guns, knives and gloves list models first; a search on that level lists matching finishes instead.
  const listsModels = FINISH_TYPES.includes(category) && !model && !query.trim();
  const visible = useMemo(() => {
    if (model) {
      const rows = sortCatalogSkins(modelSkins(model), sort, locale);
      return query.trim() ? filterCandidates(rows, query, locale) : rows;
    }
    if (listsModels) return catalogModels(category, locale).filter((item) => matchesCatalogFilter(item, category, filter));
    const rows = catalogItems(category, locale).filter((item) => matchesCatalogFilter(item, category, filter));
    return query.trim() ? filterCandidates(rows, query, locale) : rows;
  }, [category, filter, model, sort, query, listsModels, locale]);
  useEffect(() => setLimit(PAGE_SIZE), [category, filter, model, sort, query]);
  // A model's finishes start at the top; going back returns to where the model list was left.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = model ? 0 : modelListScroll.current;
  }, [model]);
  const openModel = (item) => { modelListScroll.current = scroller.current?.scrollTop || 0; setQuery(""); setModel(item); };
  const closeModel = () => { setQuery(""); setModel(null); };
  useLayoutEffect(() => {
    if (scroller.current && view === "scheme") scroller.current.scrollTop = browsingItems ? 0 : schemeListScroll.current;
  }, [browsingItems, view]);
  const changeSelection = (next) => {
    if (!setSelection(next)) return false;
    setPicker(null);
    return true;
  };
  useEffect(() => {
    const target = loadMore.current;
    if (!target || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLimit((value) => value + PAGE_SIZE);
    }, { rootMargin: "600px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [view, visible.length, limit]);

  const savePlans = (proposed) => {
    // Schemes are applied explicitly in Demo analysis; drop the old "equipped" marker.
    const next = proposed.map(({ equipped: _equipped, ...plan }) => plan);
    if (next.length > SCHEME_LIMIT || !writeWorkshopSchemes(next)) return false;
    plansRef.current = next;
    setPlans(next);
    return true;
  };

  const setInspectItem = setInspectItemState;

  /** The scheme an equip action writes to; a first scheme is created when none exists. */
  const targetPlan = () => {
    if (currentPlan) return currentPlan;
    if (plans.length) {
      setFeedback({ tone: "error", text: en ? "Select a scheme under Item schemes first." : "请先在「饰品方案」中选择要使用的方案。" });
      return null;
    }
    let created;
    try { created = emptyScheme(t("cosmeticsWorkshop.scheme.defaultName")); } catch (error) { setFeedback({ tone: "error", text: error.message }); return null; }
    if (!savePlans([created]) || !setSelection({ ...selection, selectedId: created.id })) {
      setFeedback({ tone: "error", text: en ? "Could not create a scheme." : "饰品方案创建失败。" });
      return null;
    }
    return created;
  };

  const saveToScheme = (item, teams, planId) => {
    const latest = plansRef.current;
    const plan = latest.find((row) => row.id === planId);
    if (!plan) return false;
    if (!savePlans(latest.map((row) => (row.id === plan.id ? withSchemeSelection(row, teams, item) : row)))) return false;
    const sides = teams.map(teamLabel).join(" / ");
    setFeedback({ tone: "success", text: en ? `Saved to ${sides} in ${plan.name}.` : `已保存到「${plan.name}」的 ${sides}。` });
    return true;
  };

  /** Open the create-item editor for a scheme slot; stock defaults reset the slot directly. */
  const editForScheme = (item, teams, plan) => {
    setFeedback(null);
    setDraftError("");
    if (savesWithoutEditor(item)) {
      if (saveToScheme(item, teams, plan.id)) setPicker(null);
      else setFeedback({ tone: "error", text: en ? "Could not save the scheme." : "饰品方案保存失败。" });
      return;
    }
    setDraft({ item, teams, planId: plan.id });
  };

  const confirmDraft = (item) => {
    if (saveToScheme(item, draft.teams, draft.planId)) { setDraft(null); setDraftError(""); setPicker(null); }
    else setDraftError(en ? "Could not save the scheme." : "饰品方案保存失败。");
  };

  const equipFromCatalog = (item, teams) => {
    const plan = targetPlan();
    if (plan) editForScheme(editorDraft(item), teams, plan);
  };

  const inspectInGame = async (item) => {
    setInspectBusy(true);
    setFeedback(null);
    try {
      const result = await launchCs2Inspect(item, {
        launchInspect: launchCs2InspectOnHost,
        openExternal: desktopBridge?.openExternal,
        writeClipboardText: writeInspectClipboard,
      });
      setFeedback({ tone: "success", text: t(result.status === "launched" ? "analysis.cosmetics.inspectLaunched" : "analysis.cosmetics.inspectCommandCopied") });
    } catch (error) {
      console.warn("Failed to launch CS2 inspect", error);
      setFeedback({ tone: "error", text: t("analysis.cosmetics.inspectFailed") });
    } finally {
      setInspectBusy(false);
    }
  };

  const copyInspectLink = async (link) => {
    try {
      await writeInspectClipboard(link);
      setFeedback({ tone: "success", text: en ? "Inspect URL copied." : "已复制饰品 URL。" });
    } catch (error) {
      setFeedback({ tone: "error", text: error.message });
    }
  };

  const categories = WORKSHOP_CATEGORIES.map((value) => [value, CATEGORY_LABELS[value][en ? 1 : 0]]);
  const choosePickerItem = (item) => {
    const plan = plans.find((row) => row.id === picker.planId);
    const teams = picker.category === "musickit" ? [CS2Team.CT, CS2Team.T] : [picker.team];
    if (plan) editForScheme(item, teams, plan);
  };
  const filterOptions = catalogFilterOptions(category).map((option) => ({ value: option.value, label: t(option.labelKey) }));
  const tools = model
    ? <LucasToolSelect kind="sort" label={en ? "Sort" : "排序"} value={sort} onChange={setSort}
      options={CATALOG_SORTS.map((value) => ({ value, label: SORT_LABELS[value][en ? 1 : 0] }))} />
    : filterOptions.length ? <LucasToolSelect label={t("cosmeticsWorkshop.weaponCategory.label")} value={filter} onChange={setFilter}
      options={[{ value: "all", label: en ? "All" : "全部" }, ...filterOptions]} /> : null;

  return (
    <div className="lucas-workshop h-full min-h-0">
      <LucasWorkshopBackground locale={locale} />
      <div ref={scroller} className="lucas-workshop-scroll">
      <div className="lucas-workshop-shell">
        <h1 className="sr-only">{t("cosmeticsWorkshop.title")}</h1>
        <nav className="lucas-workshop-nav" aria-label={en ? "Workshop views" : "工坊视图"}>
          <Button variant={view === "scheme" ? "primary" : "secondary"} aria-pressed={view === "scheme"} onClick={() => { setPicker(null); setView("scheme"); }}><Layers3 size={16} />{en ? "Item schemes" : "饰品方案"}</Button>
          <Button variant={view === "catalog" ? "primary" : "secondary"} aria-pressed={view === "catalog"} onClick={() => { setPicker(null); setView("catalog"); }}><LucasIcon name="boxes-stacked" />{en ? "Item catalog" : "饰品大全"}</Button>
        </nav>
        {feedback ? <p role={feedback.tone === "error" ? "alert" : "status"} className={`mt-3 ${feedback.tone === "error" ? "text-cs2-rose-on-surface" : ""}`}>{feedback.text}</p> : null}
        {view === "scheme" ? (
          <WorkshopSchemeView plans={plans} onSavePlans={savePlans} selection={selection} onSelectionChange={changeSelection} locale={locale} limit={SCHEME_LIMIT}
            itemBrowser={picker ? <WorkshopItemPicker key={`${picker.planId}:${picker.team}:${picker.category}:${picker.slotItem.catalog_id}`} category={picker.category} team={picker.team} slotItem={picker.slotItem} current={picker.current} locale={locale} onClose={() => setPicker(null)} onChoose={choosePickerItem} scrollContainer={scroller} /> : null}
            onEditSlot={({ category: slotCategory, team, slotItem, current }) => { schemeListScroll.current = scroller.current?.scrollTop || 0; setFeedback(null); setPicker({ category: slotCategory, team, slotItem, current, planId: currentPlan?.id }); }}
            />
        ) : <>
          <LucasCategoryFilter locale={locale} categories={categories} category={category}
            onCategory={(value) => { setCategory(value); setFilter("all"); setModel(null); modelListScroll.current = 0; }}
            leading={<label className="lucas-search"><LucasIcon name="magnifying-glass" /><input type="search" aria-label={en ? "Search items" : "搜索饰品"} placeholder={en ? "Search items" : "搜索饰品"} value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
            trailing={tools} />
          {model ? <div className="lucas-catalog-crumb">
            <Button variant="secondary" size="sm" onClick={closeModel}><ChevronLeft size={14} />{en ? "Back" : "返回上层"}</Button>
            <strong>{localizedName(model, locale)}</strong>
            <span>{en ? `${modelSkinCount(model)} finishes` : `共 ${modelSkinCount(model)} 款`}</span>
          </div> : null}
          <section className="lucas-grid" aria-label={en ? "Item catalog" : "饰品大全"}>
            {visible.slice(0, limit).map((item) => listsModels
              ? <ModelTile key={item.catalog_id} item={item} en={en} locale={locale} onOpen={openModel} />
              : <CatalogTile key={item.catalog_id} item={item} locale={locale} inspectBusy={inspectBusy}
                onEquip={equipFromCatalog} onInspect3d={(preview) => setInspectItem(preview)} onInspectInGame={(preview) => void inspectInGame(preview)} onCopy={(link) => void copyInspectLink(link)} />)}
          </section>
          {visible.length > limit ? <div ref={loadMore} className="lucas-load-more"><Button variant="secondary" size="sm" onClick={() => setLimit(limit + PAGE_SIZE)}>{en ? `Show more (${visible.length - limit} left)` : `显示更多（还有 ${visible.length - limit} 件）`}</Button></div> : null}
          {!visible.length ? <div className="lucas-empty"><span aria-hidden>ⓘ</span><p>{en ? "No items to display." : "没有可显示的饰品。"}</p></div> : null}
        </>}
      </div>
      </div>
      {draft && FINISH_TYPES.includes(draft.item.type) ? <LucasItemEditorModal item={draft.item} locale={locale} wear={draft.item.paint_wear} seed={draft.item.paint_seed}
        saveError={draftError}
        onItemChange={(item) => setDraft((current) => ({ ...current, item }))}
        onWearChange={(value) => setDraft((current) => ({ ...current, item: { ...current.item, paint_wear: value } }))}
        onSeedChange={(value) => setDraft((current) => ({ ...current, item: { ...current.item, paint_seed: value } }))}
        onClose={() => { setDraft(null); setDraftError(""); }}
        onConfirm={() => confirmDraft({ ...draft.item, paint_wear: Number(draft.item.paint_wear), paint_seed: Number(draft.item.paint_seed) })}
        confirmLabel={en ? "Save to scheme" : "保存到方案"} onInspectInGame={() => void inspectInGame(draft.item)} onInspect3d={() => setInspectItem({ ...draft.item, paint_wear: Number(draft.item.paint_wear), paint_seed: Number(draft.item.paint_seed) })}
        preview={<WorkshopItemImage catalogOnly item={draft.item} wear={Number(draft.item.paint_wear)} className="h-full w-full object-contain" />} /> : null}
      <InspectModal item={inspectItem} locale={locale} onClose={() => setInspectItem(null)} />
    </div>
  );
}
