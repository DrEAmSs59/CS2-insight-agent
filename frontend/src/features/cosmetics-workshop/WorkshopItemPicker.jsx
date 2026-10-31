import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Pencil } from "lucide-react";
import Button from "../../components/ui/Button.jsx";
import { useT } from "../../i18n/useT.js";
import { LucasItemTile } from "./LucasWorkshop.jsx";
import LucasIcon from "./LucasIcon.jsx";
import WorkshopItemImage from "./WorkshopItemImage.jsx";
import WorkshopModelSkins from "./WorkshopModelSkins.jsx";
import { editorDraft } from "./itemAppearance.js";
import { CATEGORY_LABELS, FINISH_TYPES, TEAM_KEYS, localizedName, modelSkinCount, schemeModelChoices } from "./workshopCatalog.js";
import { craftNameParts, filterCandidates } from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

const PAGE_SIZE = 120;

/** All scheme slots use page navigation; knives and gloves list their models first. */
export default function WorkshopItemPicker({ category, team, slotItem, current = null, locale, onClose, onChoose, scrollContainer }) {
  const t = useT();
  const en = locale === "en";
  const choices = useMemo(() => schemeModelChoices(category, team, slotItem), [category, team, slotItem]);
  const [model, setModel] = useState(() => category === "weapon" ? choices[0] : null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const modelListScroll = useRef(0);
  const listsModels = FINISH_TYPES.includes(category);
  const rows = useMemo(() => query.trim() ? filterCandidates(choices, query, locale) : choices, [choices, query, locale]);
  useEffect(() => setLimit(PAGE_SIZE), [query]);
  useLayoutEffect(() => {
    if (scrollContainer?.current) scrollContainer.current.scrollTop = model ? 0 : modelListScroll.current;
  }, [model, scrollContainer]);

  if (model) return <WorkshopModelSkins key={model.catalog_id} item={model} current={current} locale={locale} team={team}
    onBack={category === "weapon" ? onClose : () => setModel(null)} onChoose={onChoose} />;

  const kind = CATEGORY_LABELS[category][en ? 1 : 0];
  const title = en ? `Select ${kind.toLowerCase()}` : `选择${kind}`;
  return <div className="lucas-scheme-picker">
    <div className="lucas-catalog-crumb">
      <Button variant="secondary" size="sm" onClick={onClose}><ChevronLeft size={14} />{en ? "Back" : "返回上层"}</Button>
      <strong>{title}</strong>
      <span>{TEAM_KEYS[team].toUpperCase()} · {en ? `${rows.length} items` : `共 ${rows.length} 件`}</span>
      {current ? <Button variant="secondary" size="sm" onClick={() => onChoose({ ...current })}><Pencil size={13} />{en ? "Edit current item" : "编辑当前饰品"}</Button> : null}
    </div>
    <div className="lucas-filter-tools">
      <label className="lucas-search"><LucasIcon name="magnifying-glass" /><input type="search" aria-label={en ? "Search items" : "搜索饰品"} placeholder={en ? "Search items" : "搜索饰品"} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    <section className="lucas-grid" aria-label={title}>
      {rows.slice(0, limit).map((item) => {
        const name = listsModels ? (!item.free && craftNameParts(item, locale).model) || localizedName(item, locale) : localizedName(item, locale);
        const count = listsModels ? modelSkinCount(item) : 0;
        return <LucasItemTile key={item.catalog_id} label={name} model={listsModels ? name : null}
          finish={listsModels ? (en ? `${count} finishes` : `${count} 款皮肤`) : name} rarity={item.rarity}
          selected={listsModels ? item.def_index === (current || slotItem).def_index : item.catalog_id === (current || slotItem).catalog_id}
          image={<WorkshopItemImage catalogOnly item={item} className="h-full w-full" />}
          onClick={() => {
            if (listsModels) { modelListScroll.current = scrollContainer?.current?.scrollTop || 0; setModel(item); }
            else onChoose(editorDraft(item));
          }} />;
      })}
    </section>
    {rows.length > limit ? <div className="lucas-load-more"><Button variant="secondary" size="sm" onClick={() => setLimit(limit + PAGE_SIZE)}>{t("cosmeticsWorkshop.attachments.more")}</Button></div> : null}
    {!rows.length ? <div className="lucas-empty"><p>{t("cosmeticsWorkshop.attachments.empty")}</p></div> : null}
  </div>;
}
