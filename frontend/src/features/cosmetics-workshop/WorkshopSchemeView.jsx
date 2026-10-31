import { useMemo, useState } from "react";
import { Link, Pencil, Plus, Trash2 } from "lucide-react";
import { CS2Team } from "@ianlucas/cs2-lib";
import Button from "../../components/ui/Button.jsx";
import { useT } from "../../i18n/useT.js";
import { LucasButton, LucasCategoryFilter, LucasItemTile, LucasModal, LucasSelect, LucasToolSelect } from "./LucasWorkshop.jsx";
import WorkshopItemImage from "./WorkshopItemImage.jsx";
import {
  CATEGORY_LABELS, TEAM_KEYS, WORKSHOP_CATEGORIES, catalogFilterOptions, localizedName,
  matchesCatalogFilter, schemeDefaults, schemeSlotKey,
} from "./workshopCatalog.js";
import { craftNameParts } from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

export function emptyScheme(name) {
  return { id: crypto.randomUUID(), name, selections: { ct: {}, t: {} } };
}

/**
 * Scheme editor: one tile per item kind for the chosen side. Clicking a tile
 * opens its page browser; the saved item replaces the slot.
 */
export default function WorkshopSchemeView({ plans, onSavePlans, selection, onSelectionChange, locale, limit, onEditSlot, onImport, itemBrowser }) {
  const t = useT();
  const en = locale === "en";
  const { selectedId, team } = selection;
  const [category, setCategory] = useState("weapon");
  const [weaponFilter, setWeaponFilter] = useState("all");
  const [dialog, setDialog] = useState(null), [name, setName] = useState("");
  const [error, setError] = useState("");
  const plan = plans.find((row) => row.id === selectedId) || null;
  const side = TEAM_KEYS[team];

  function changeSelection(next) {
    if (!onSelectionChange(next)) { setError(en ? "Could not remember the scheme selection." : "饰品方案选择保存失败。"); return false; }
    setError(""); return true;
  }
  const savePlans = (next) => {
    if (!onSavePlans(next)) { setError(en ? "Could not save the scheme. Your changes have not been applied." : "饰品方案保存失败，本次更改尚未应用。"); return false; }
    setError(""); return true;
  };
  function submitDialog() {
    let next;
    if (dialog === "delete") next = plans.filter((row) => row.id !== selectedId);
    else if (dialog === "create") {
      let created;
      try { created = emptyScheme(name.trim()); } catch (failure) { setError(failure.message); return; }
      if (savePlans([...plans, created])) { changeSelection({ ...selection, selectedId: created.id }); setDialog(null); }
      return;
    } else next = plans.map((row) => (row.id === selectedId ? { ...row, name: name.trim() } : row));
    if (savePlans(next)) { if (dialog === "delete") changeSelection({ ...selection, selectedId: "" }); setDialog(null); }
  }

  const slots = useMemo(() => schemeDefaults(category, team)
    .filter((item) => category !== "weapon" || matchesCatalogFilter(item, category, weaponFilter))
    .map((fallback) => {
      const chosen = plan?.selections?.[side]?.[schemeSlotKey(fallback)] || null;
      return { fallback, item: chosen || fallback, custom: Boolean(chosen) };
    }), [category, team, weaponFilter, plan, side]);
  const categories = WORKSHOP_CATEGORIES.map((value) => [value, CATEGORY_LABELS[value][en ? 1 : 0]]);
  const teamSwitch = <div className="lucas-team-switch" role="group" aria-label={en ? "Side" : "阵营"}>
    {[CS2Team.CT, CS2Team.T].map((value) => <Button key={value} variant="secondary" size="sm" aria-pressed={team === value} data-team={TEAM_KEYS[value]} onClick={() => team === value || changeSelection({ ...selection, team: value })}>{TEAM_KEYS[value].toUpperCase()}</Button>)}
  </div>;

  return <section className="lucas-loadout" aria-label={en ? "Item schemes" : "饰品方案"}>
    <div className="lucas-loadout-toolbar">
      <strong>{en ? "Item scheme" : "饰品方案"}</strong>
      <LucasSelect label={en ? "Select scheme" : "选择方案"} value={selectedId} onChange={(id) => changeSelection({ ...selection, selectedId: id })} options={[{ value: "", label: en ? "None" : "无" }, ...plans.map((row) => ({ value: row.id, label: row.name }))]} />
      <Button size="sm" disabled={plans.length >= limit} title={plans.length >= limit ? (en ? `Limit: ${limit}` : `最多 ${limit} 套方案`) : undefined} onClick={() => { setName(""); setDialog("create"); }}><Plus size={14} />{en ? "Create" : "创建"}</Button>
      {plan ? <>
        <Button variant="secondary" size="sm" onClick={() => { setName(plan.name); setDialog("rename"); }}><Pencil size={14} />{en ? "Rename" : "重命名"}</Button>
        <Button variant="danger" size="sm" onClick={() => setDialog("delete")}><Trash2 size={14} />{en ? "Delete" : "删除"}</Button>
      </> : null}
    </div>
    {error ? <p role="alert" className="lucas-loadout-message">{error}</p> : null}
    {plan ? <div className="lucas-loadout-body">
      {itemBrowser || <>
      <LucasCategoryFilter locale={locale} categories={categories} category={category} onCategory={(value) => { setCategory(value); setWeaponFilter("all"); }}
        leading={teamSwitch}
        trailing={category === "weapon" ? <LucasToolSelect label={t("cosmeticsWorkshop.weaponCategory.label")} value={weaponFilter} onChange={setWeaponFilter}
          options={[{ value: "all", label: en ? "All" : "全部" }, ...catalogFilterOptions("weapon").map((option) => ({ value: option.value, label: t(option.labelKey) }))]} /> : null} />
      <section className="lucas-grid" aria-label={en ? `${TEAM_KEYS[team].toUpperCase()} scheme items` : `${TEAM_KEYS[team].toUpperCase()} 方案饰品`}>
        {slots.map(({ fallback, item, custom }) => {
          const parts = craftNameParts(item, locale);
          const finish = item.custom_name ? `"${item.custom_name}"` : item.is_base ? "" : [parts.finish, parts.alt].filter(Boolean).join(" · ") || localizedName(item, locale);
          const model = item.custom_name || !item.is_base ? parts.model : localizedName(item, locale);
          return <LucasItemTile key={schemeSlotKey(fallback)}
            label={[model, finish].filter(Boolean).join(" | ")}
            model={model} finish={finish} rarity={item.rarity}
            badge={custom ? <span title={en ? "Customised" : "已自定义"}>✓</span> : undefined}
            image={<WorkshopItemImage item={item} catalogOnly={!custom} className="h-full w-full" />}
            onClick={() => onEditSlot({ category, team, slotItem: fallback, current: custom ? item : null })} />;
        })}
      </section>
      </>}
    </div> : <div className="lucas-empty"><span aria-hidden>ⓘ</span><p role="status">{en ? "Create or select a scheme to customise items." : "请先创建或选择饰品方案。"}</p></div>}
    <LucasModal open={!!dialog} title={dialog === "create" ? (en ? "Create scheme" : "创建饰品方案") : plan?.name} onClose={() => setDialog(null)} footer={<><LucasButton variant="secondary" onClick={() => setDialog(null)}>{en ? "Cancel" : "取消"}</LucasButton><LucasButton disabled={(dialog === "create" || dialog === "rename") && !name.trim()} onClick={submitDialog}>{en ? "OK" : "确定"}</LucasButton></>}>
      {dialog === "create" || dialog === "rename" ? <input autoFocus className="lucas-loadout-name" aria-label={en ? "Scheme name" : "方案名称"} maxLength={32} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) submitDialog(); }} /> : <p className="p-6">{en ? "Delete this scheme?" : "删除此饰品方案？"}</p>}
      {error ? <p role="alert">{error}</p> : null}
    </LucasModal>
  </section>;
}
