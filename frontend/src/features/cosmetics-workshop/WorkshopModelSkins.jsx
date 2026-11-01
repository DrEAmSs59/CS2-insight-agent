import { useMemo, useState } from "react";
import { ChevronLeft, Pencil } from "lucide-react";
import Button from "../../components/ui/Button.jsx";
import { useT } from "../../i18n/useT.js";
import { LucasItemTile, LucasToolSelect } from "./LucasWorkshop.jsx";
import LucasIcon from "./LucasIcon.jsx";
import WorkshopItemImage from "./WorkshopItemImage.jsx";
import { editorDraft } from "./itemAppearance.js";
import { currentItemFirst } from "./workshopCurrentItem.js";
import { CATALOG_SORTS, TEAM_KEYS, localizedName, modelFinishes, sortCatalogSkins } from "./workshopCatalog.js";
import { craftNameParts, filterCandidates, isVanillaKnife } from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

const SORT_LABELS = { newest: ["最新添加", "Newest first"], name: ["名称", "Name"], rarity: ["品质", "Rarity"] };
const RARITIES = { "#b0c3d9": "consumer", "#5e98d9": "industrial", "#4b69ff": "milspec", "#8847ff": "restricted", "#d32ce6": "classified", "#eb4b4b": "covert", "#e4ae39": "contraband" };

/** Full-page scheme slot browser using the catalogue's tiles, search and sorting. */
export default function WorkshopModelSkins({ item, current, locale, team, onBack, onChoose }) {
  const t = useT();
  const en = locale === "en";
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [rarity, setRarity] = useState("all");
  const finishes = useMemo(() => modelFinishes(item), [item]);
  const equipped = current?.type === item.type && Number(current.def_index) === Number(item.def_index) ? current : null;
  const rows = useMemo(() => {
    const sorted = currentItemFirst([finishes[0], ...sortCatalogSkins(finishes.slice(1), sort, locale)], equipped, { keepStock: equipped?.is_base && !isVanillaKnife(equipped) && Boolean(equipped.attachment_edit_version) })
      .filter((row) => rarity === "all" || row.rarity === rarity);
    return query.trim() ? filterCandidates(sorted, query, locale) : sorted;
  }, [finishes, equipped, sort, locale, rarity, query]);
  const name = localizedName(item, locale);

  return <div className="lucas-model-skins">
    <div className="lucas-catalog-crumb">
      <Button variant="secondary" size="sm" onClick={onBack}><ChevronLeft size={14} />{en ? "Back" : "返回上层"}</Button>
      <strong>{name}</strong>
      <span>{TEAM_KEYS[team].toUpperCase()} · {en ? `${rows.length} items` : `共 ${rows.length} 件`}</span>
      {current ? <Button variant="secondary" size="sm" onClick={() => onChoose({ ...current })}><Pencil size={13} />{en ? "Edit current item" : "编辑当前饰品"}</Button> : null}
    </div>
    <div className="lucas-filter-tools">
      <label className="lucas-search"><LucasIcon name="magnifying-glass" /><input type="search" aria-label={en ? "Search items" : "搜索饰品"} placeholder={t("cosmeticsWorkshop.skin.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <LucasToolSelect label={en ? "Filter skins" : "筛选皮肤"} value={rarity} onChange={setRarity}
        options={[{ value: "all", label: en ? "All qualities" : "全部品质" }, ...Object.entries(RARITIES).filter(([color]) => finishes.some((row) => row.rarity === color)).map(([color, key]) => ({ value: color, label: t(`analysis.cosmetics.rarity.${key}`) }))]} />
      <LucasToolSelect kind="sort" label={en ? "Sort" : "排序"} value={sort} onChange={setSort}
        options={CATALOG_SORTS.map((value) => ({ value, label: SORT_LABELS[value][en ? 1 : 0] }))} />
    </div>
    <section className="lucas-grid" aria-label={en ? `${name} skins` : `${name} 皮肤`}>
      {rows.map((row) => {
        const parts = craftNameParts(row, locale);
        const stock = row.is_base && !isVanillaKnife(row);
        const finish = [stock ? "" : [parts.finish, parts.alt].filter(Boolean).join(" · "), row.custom_name && `"${row.custom_name}"`].filter(Boolean).join(" · ");
        return <LucasItemTile key={row === equipped ? "current" : row.catalog_id} label={stock && !finish ? localizedName(row, locale) : [stock ? localizedName(row, locale) : parts.model, finish].filter(Boolean).join(" | ")}
          model={stock ? localizedName(row, locale) : parts.model} finish={finish} rarity={row.rarity}
          selected={current ? row === equipped : row.is_base}
          badge={row === equipped ? <span>{en ? "In use" : "正在使用"}</span> : undefined}
          image={<WorkshopItemImage catalogOnly={row !== equipped} item={row} className="h-full w-full" />}
          onClick={() => onChoose(row === equipped ? { ...equipped } : editorDraft(row))} />;
      })}
    </section>
    {!rows.length ? <div className="lucas-empty"><p>{en ? "No items to display." : "没有可显示的饰品。"}</p></div> : null}
  </div>;
}
