/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Copy,
  Gem,
  Info,
  Loader2,
  PackageOpen,
  Rotate3D,
  Sticker,
  WifiOff,
  X,
} from "lucide-react";
import { useT } from "../../i18n/useT.js";
import { steamIdForPlayer } from "../../utils/playerAppearance.js";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { craftNameParts, formatCraftPipeName, imageUrlForWear, listDefaultLoadout } from "./cosmeticsCatalog.js";
import { isCustomizable, itemsForTeam, mergeLoadoutWithEvidence, slotKey, sortCosmeticsForRow } from "./cosmeticsLayout.js";
import SkinReplacementPicker from "./SkinReplacementPicker.jsx";
import { saveCustomSkinPlan, loadCustomSkinPlan } from "./saveCustomSkinPlan.js";

function replacementsFromPlan(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (!items.length) return null;
  const next = {};
  for (const row of items) {
    const key = String(row?.slot_key || "").trim();
    if (!key || !row?.replacement || typeof row.replacement !== "object") continue;
    next[key] = row.replacement;
  }
  return Object.keys(next).length ? next : null;
}

/** Original demo skins stored in a custom plan (survives post-apply inventory drift). */
function originalsFromPlan(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (!items.length) return {};
  const next = {};
  for (const row of items) {
    const key = String(row?.slot_key || "").trim();
    if (!key || !row?.original || typeof row.original !== "object") continue;
    next[key] = row.original;
  }
  return next;
}

function cosmeticPreview(item, replacement) {
  if (!replacement) return item;
  return {
    ...item,
    ...replacement,
    // Replaced skins do not keep the original weapon's stickers.
    // Restoring the original keeps demo sticker evidence.
    stickers: replacement.restore ? (item?.stickers || []) : [],
    custom_name: item?.custom_name,
    image_url: replacement.image_url || item?.image_url,
    rarity: replacement.rarity || item?.rarity,
    paint_wear: Number.isFinite(Number(replacement.paint_wear))
      ? Number(replacement.paint_wear)
      : item?.paint_wear,
    paint_index: Number.isFinite(Number(replacement.paint_index))
      ? Number(replacement.paint_index)
      : item?.paint_index,
    is_placeholder: false,
    is_base: false,
    finish_known: replacement.finish_known !== false,
  };
}

/** Restore demo-original look after clearing a replacement (keeps live stickers). */
function restoreOriginalVisual(item, snapshot) {
  if (!snapshot) return item;
  return {
    ...item,
    ...snapshot,
    image_url: snapshot.image_url || item?.image_url,
    stickers: item?.stickers,
    custom_name: item?.custom_name || snapshot.custom_name,
    item_id: item?.item_id,
  };
}

function snapshotOriginalItem(item) {
  return {
    item_id: item?.item_id,
    type: item?.type,
    def_index: item?.def_index,
    paint_index: item?.paint_index,
    paint_seed: item?.paint_seed,
    paint_wear: item?.paint_wear,
    name_zh: item?.name_zh,
    name_en: item?.name_en,
    alt_name: item?.alt_name,
    image_url: item?.image_url,
    rarity: item?.rarity,
    custom_name: item?.custom_name,
    finish_known: item?.finish_known,
    is_base: item?.is_base,
    is_placeholder: item?.is_placeholder,
    catalog_id: item?.catalog_id,
    model: item?.model,
  };
}

/** Keep first-seen demo originals; never let a later plan overwrite them with the new skin. */
function mergeOriginalsPreferExisting(fromPlan, existing) {
  const next = { ...(fromPlan || {}) };
  for (const [key, value] of Object.entries(existing || {})) {
    if (value && typeof value === "object") next[key] = value;
  }
  return next;
}

/** Turn a demo-original snapshot into a saveable replacement that restores that skin. */
function restoreReplacementFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const paintIndex = Number(snapshot.paint_index);
  const paintSeed = Number(snapshot.paint_seed);
  const paintWear = Number(snapshot.paint_wear);
  return {
    catalog_id: snapshot.catalog_id,
    def_index: snapshot.def_index,
    paint_index: Number.isFinite(paintIndex) ? paintIndex : 0,
    paint_seed: Number.isFinite(paintSeed) ? Math.trunc(paintSeed) : 0,
    paint_wear: Number.isFinite(paintWear) ? paintWear : 0,
    model: snapshot.model,
    type: snapshot.type,
    name_en: snapshot.name_en,
    name_zh: snapshot.name_zh,
    alt_name: snapshot.alt_name,
    image_url: snapshot.image_url,
    rarity: snapshot.rarity,
    finish_known: snapshot.finish_known,
    restore: true,
  };
}

/** Drop UI-only flags before posting replacements to the API. */
function replacementsForApi(replacements) {
  const out = {};
  for (const [key, value] of Object.entries(replacements || {})) {
    if (!value || typeof value !== "object") continue;
    const { restore: _restore, ...rest } = value;
    out[key] = rest;
  }
  return out;
}

const RARITY_NAMES = {
  "#ded6cc": "consumer",
  "#b0c3d9": "consumer",
  "#5e98d9": "industrial",
  "#4b69ff": "milspec",
  "#8847ff": "restricted",
  "#d32ce6": "classified",
  "#eb4b4b": "covert",
  "#e4ae39": "contraband",
};

function playerName(player) {
  return String(player?.name || player?.player_name || "").trim();
}

function localized(item, field, locale) {
  const chinese = String(item?.[`${field}_zh`] || "").trim();
  const english = String(item?.[`${field}_en`] || "").trim();
  return String(locale || "").toLowerCase().startsWith("zh")
    ? chinese || english
    : english || chinese;
}

function displayName(item, locale) {
  return localized(item, "name", locale) || String(item?.model || "CS2");
}

function saveResultOriginalName(row, locale) {
  const zh = String(row?.original_name_zh || "").trim();
  const en = String(row?.original_name_en || "").trim();
  if (String(locale || "").toLowerCase().startsWith("zh")) {
    return zh || en || "";
  }
  return en || zh || "";
}

function saveResultReplacementName(row, locale) {
  const zh = String(row?.replacement_name_zh || row?.name_zh || "").trim();
  const en = String(row?.replacement_name_en || row?.name_en || "").trim();
  if (String(locale || "").toLowerCase().startsWith("zh")) {
    return zh || en || String(row?.item_id64 || "");
  }
  return en || zh || String(row?.item_id64 || "");
}

/** Fill original/replacement names from local inventory when API omits them. */
function enrichSaveResultRows(rows, inventoryRows, replacements) {
  const bySlot = new Map();
  const byItemId = new Map();
  for (const item of inventoryRows || []) {
    const key = slotKey(item);
    if (key) bySlot.set(key, item);
    const id = String(item?.item_id ?? "").trim();
    if (id && id !== "0") byItemId.set(id, item);
  }
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const slot = String(row?.slot_key || "").trim();
    const itemId = String(row?.item_id64 || "").trim();
    const original = (slot && bySlot.get(slot)) || (itemId && byItemId.get(itemId)) || null;
    const replacement = (slot && replacements?.[slot]) || null;
    return {
      ...row,
      original_name_zh: row?.original_name_zh || original?.name_zh || "",
      original_name_en: row?.original_name_en || original?.name_en || "",
      replacement_name_zh: row?.replacement_name_zh || row?.name_zh || replacement?.name_zh || "",
      replacement_name_en: row?.replacement_name_en || row?.name_en || replacement?.name_en || "",
    };
  });
}

function customName(item) {
  return typeof item?.custom_name === "string" ? item.custom_name : "";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function exteriorKey(wear) {
  const value = Number(wear);
  if (!Number.isFinite(value)) return "unknown";
  if (value < 0.07) return "factoryNew";
  if (value < 0.15) return "minimalWear";
  if (value < 0.38) return "fieldTested";
  if (value < 0.45) return "wellWorn";
  return "battleScarred";
}

function eligibleTeams(item) {
  const teams = Number(item?.teams);
  if (teams === 0) return ["t"];
  if (teams === 1) return ["ct"];
  if (teams === 2) return ["t", "ct"];
  return [];
}

function canInspect3d(item, onlineAssetsEnabled) {
  return Boolean(
    onlineAssetsEnabled
      && item?.catalog_exact !== false
      && Number.isInteger(Number(item?.catalog_id))
      && ["weapon", "melee"].includes(String(item?.type || "")),
  );
}

function canInspectInGame(item) {
  return Boolean(
    item?.catalog_exact !== false
      && item?.finish_known !== false
      && Number.isInteger(Number(item?.catalog_id)),
  );
}

function viewerUrl(item) {
  const viewerItem = { id: Number(item?.catalog_id) };
  if (Number.isFinite(Number(item?.paint_seed))) viewerItem.seed = Number(item.paint_seed);
  if (Number.isFinite(Number(item?.paint_wear))) viewerItem.wear = Number(item.paint_wear);
  if (customName(item)) viewerItem.nameTag = customName(item);
  const stickers = Array.isArray(item?.stickers) ? item.stickers : [];
  if (stickers.length) {
    viewerItem.stickers = Object.fromEntries(stickers.flatMap((sticker, index) => {
      const id = Number(sticker?.catalog_id);
      return Number.isInteger(id) ? [[String(sticker?.slot ?? index), { id, wear: sticker?.wear }]] : [];
    }));
  }
  const url = new URL("https://3d.cstrike.app/view");
  url.searchParams.set("halfRotation", "1");
  // The hosted viewer defaults to its own light scene backdrop. Disable that
  // layer so its transparent WebGL canvas inherits our inspect stage instead.
  url.searchParams.set("bg", "0");
  url.searchParams.set("item", JSON.stringify(viewerItem));
  return url.toString();
}

function TeamIndicators({ item, compact = false }) {
  const t = useT();
  const observed = new Set(Array.isArray(item?.observed_teams) ? item.observed_teams : []);
  if (!observed.size) return null;
  return (
    <span className="flex items-center gap-1" aria-label={t("analysis.cosmetics.teamEvidence")}>
      {["ct", "t"].filter((team) => observed.has(team)).map((team) => (
        <span
          key={team}
          title={t(`analysis.cosmetics.observed.${team}`)}
          className={`${compact ? "h-3 w-3" : "h-4 w-4"} inline-flex items-center justify-center rounded-full border-2 ${
            team === "ct"
              ? "border-sky-300 bg-sky-400/20 text-sky-200"
              : "border-amber-300 bg-amber-400/20 text-amber-200"
          }`}
        >
          {!compact ? <span className="text-[7px] font-black uppercase leading-none">{team === "ct" ? "C" : "T"}</span> : null}
        </span>
      ))}
    </span>
  );
}

function CosmeticImage({ item, onlineAssetsEnabled, className = "" }) {
  const [failed, setFailed] = useState(false);
  const base = onlineAssetsEnabled ? String(item?.image_url || "") : "";
  const src = onlineAssetsEnabled && !failed
    ? imageUrlForWear(base, item?.paint_wear, item)
    : "";
  useEffect(() => setFailed(false), [item?.image_url, item?.paint_wear, item?.paint_index, item?.is_placeholder, onlineAssetsEnabled]);
  if (!src) {
    return (
      <span className={`flex items-center justify-center text-cs2-text-muted ${className}`}>
        {onlineAssetsEnabled ? <PackageOpen className="h-9 w-9 opacity-55" /> : <WifiOff className="h-8 w-8 opacity-55" />}
      </span>
    );
  }
  return (
    <img
      key={src}
      src={src}
      alt={String(item?.name_zh || item?.name_en || "")}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`object-contain ${className}`}
    />
  );
}

function CraftNameLines({ item, locale, rename = "", compact = false }) {
  const parts = craftNameParts(item, locale);
  const rarityColor = String(item?.rarity || "").trim() || "#ded6cc";
  const sizeClass = compact ? "text-[10px]" : "text-[11px]";
  const baseClass = `break-words font-semibold leading-snug ${sizeClass}`;
  const sep = <span className="text-cs2-text-muted"> | </span>;
  const hasModel = Boolean(parts.model);
  const hasFinish = Boolean(parts.finish);
  const hasAlt = Boolean(parts.alt);
  const fallback = !hasModel && !hasFinish && !hasAlt ? parts.full : "";

  const pipe = (hasModel || hasFinish || hasAlt || fallback) ? (
    <span className={`block min-w-0 ${baseClass}`}>
      {hasModel ? <span className="text-cs2-text-secondary">{parts.model}</span> : null}
      {hasFinish ? (
        <>
          {hasModel ? sep : null}
          <span style={{ color: rarityColor }}>{parts.finish}</span>
        </>
      ) : null}
      {hasAlt ? (
        <>
          {(hasModel || hasFinish) ? sep : null}
          <span style={{ color: rarityColor }}>{parts.alt}</span>
        </>
      ) : null}
      {fallback ? <span style={{ color: rarityColor }}>{fallback}</span> : null}
    </span>
  ) : null;

  if (rename) {
    return (
      <>
        <span className="block break-words text-[11px] font-black leading-snug text-cs2-text-primary">“{rename}”</span>
        {pipe ? <span className="mt-0.5 block">{pipe}</span> : null}
      </>
    );
  }
  return pipe;
}

function CosmeticCard({
  item,
  labelItem,
  locale,
  onlineAssetsEnabled,
  customMode,
  customizable,
  replacement,
  replacementLabel,
  onOpen,
  onHoverStart,
  onHoverEnd,
  onClearReplacement,
}) {
  const t = useT();
  const labelSource = labelItem || item;
  const rename = customName(labelSource);
  const name = displayName(labelSource, locale);
  const accessibleName = rename || formatCraftPipeName(labelSource, locale) || name;
  const disabled = customMode && !customizable;
  const stickers = Array.isArray(item?.stickers) ? item.stickers : [];
  const showClear = Boolean(customMode && replacement && !replacement.restore && onClearReplacement);
  return (
    <button
      type="button"
      onClick={() => onOpen?.(item, item)}
      onPointerEnter={(event) => onHoverStart?.(event, item)}
      onPointerLeave={onHoverEnd}
      onFocus={(event) => onHoverStart?.(event, item)}
      onBlur={onHoverEnd}
      data-cosmetic-card
      className={`group grid w-full min-w-0 self-start grid-rows-[auto_auto] text-left outline-none${
        disabled ? " cursor-not-allowed opacity-50 grayscale" : ""
      }`}
      aria-label={accessibleName}
    >
      <span className="relative block aspect-[4/3] overflow-hidden rounded-[3px] border border-cs2-border bg-cs2-bg-input transition-colors group-hover:border-cs2-text-muted group-focus-visible:border-cs2-accent">
        {showClear ? (
          <span
            role="button"
            tabIndex={0}
            data-testid="cosmetics-clear-replacement"
            aria-label={t("analysis.cosmetics.clearReplacement")}
            title={t("analysis.cosmetics.clearReplacement")}
            className="absolute right-1 top-1 z-[2] inline-flex h-6 w-6 items-center justify-center rounded border border-cs2-border bg-cs2-bg-page/90 text-cs2-text-muted shadow hover:border-rose-400/60 hover:text-rose-300"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClearReplacement();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onClearReplacement();
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <X className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <CosmeticImage item={item} onlineAssetsEnabled={onlineAssetsEnabled} className="h-full w-full p-2" />
        {onlineAssetsEnabled && stickers.length ? (
          <span className="absolute bottom-1 left-1 z-[1] flex max-w-[85%] items-end gap-1">
            {stickers.slice(0, 5).map((sticker, index) => (
              <img key={`${sticker?.catalog_id || "sticker"}-${index}`} src={sticker?.image_url} alt="" className="h-8 w-8 object-contain drop-shadow" />
            ))}
          </span>
        ) : null}
        <span className="absolute inset-x-0 bottom-0 h-1" style={{ backgroundColor: item?.rarity || "#ded6cc" }} />
      </span>
      <span data-cosmetic-card-label className="mt-1.5 block min-h-8 min-w-0 overflow-hidden leading-tight">
        <CraftNameLines item={labelSource} locale={locale} rename={rename} compact />
        {replacementLabel ? <span className="mt-0.5 block break-words text-[10px] font-semibold leading-snug text-cs2-accent">{replacementLabel}</span> : null}
      </span>
    </button>
  );
}

function CosmeticsTeamRow({
  team,
  items,
  locale,
  onlineAssetsEnabled,
  customMode,
  localReplacements,
  originalBySlot,
  onOpen,
  onHoverStart,
  onHoverEnd,
  onClearReplacement,
  showHeading = true,
}) {
  const t = useT();
  const teamKey = team === "ct" ? "ct" : "t";
  return (
    <section data-testid={`cosmetics-row-${teamKey}`} className="space-y-2">
      {showHeading ? (
        <h3 className="text-[11px] font-black uppercase tracking-wide text-cs2-text-muted">{t(`analysis.cosmetics.team.${teamKey}`)}</h3>
      ) : null}
      {items.length ? (
        <div className="grid grid-cols-2 items-start gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {sortCosmeticsForRow(items, locale, (item) => {
            const key = slotKey(item);
            const replacement = localReplacements?.[key];
            const snapshot = originalBySlot?.[key];
            if (replacement) return cosmeticPreview(item, replacement);
            return restoreOriginalVisual(item, snapshot);
          }).map((item, index) => {
            const key = slotKey(item);
            const replacement = localReplacements?.[key] || null;
            const snapshot = originalBySlot?.[key] || null;
            const visualItem = replacement
              ? cosmeticPreview(item, replacement)
              : restoreOriginalVisual(item, snapshot);
            const labelItem = snapshot
              ? {
                  ...snapshot,
                  custom_name: snapshot.custom_name || item?.custom_name,
                  item_id: item?.item_id,
                }
              : item;
            return (
            <CosmeticCard
              key={`${teamKey}-${item?.item_id || item?.catalog_id || "item"}-${index}`}
              item={visualItem}
              labelItem={labelItem}
              locale={locale}
              onlineAssetsEnabled={onlineAssetsEnabled}
              customMode={customMode}
              customizable={isCustomizable(item)}
              replacement={replacement}
              replacementLabel={replacement && !replacement.restore ? t("analysis.cosmetics.replacementPreview", {
                name: formatCraftPipeName(replacement, locale) || displayName(replacement, locale),
              }) : null}
              onOpen={() => onOpen?.(item, visualItem)}
              onHoverStart={(event) => onHoverStart?.(event, visualItem)}
              onHoverEnd={onHoverEnd}
              onClearReplacement={replacement && !replacement.restore && onClearReplacement
                ? () => onClearReplacement(key)
                : null}
            />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function WearBar({ wear, wearMin, wearMax, compact = false }) {
  const value = Number(wear);
  if (!Number.isFinite(value)) return null;
  const position = Math.max(0, Math.min(100, value * 100));
  const min = finiteNumber(wearMin);
  const max = finiteNumber(wearMax);
  const bounded = min !== null && max !== null && (min > 0 || max < 1);
  return (
    <div className={compact ? "mt-2" : "mt-3"}>
      <div className={`${compact ? "h-1" : "h-1.5"} relative overflow-visible bg-[linear-gradient(90deg,#3b818f_0%,#3b818f_7%,#83b135_7%,#83b135_15%,#d7be47_15%,#d7be47_38%,#f08140_38%,#f08140_45%,#ec4f3d_45%,#ec4f3d_100%)]`}>
        {bounded ? (
          <>
            <span className="absolute inset-y-0 left-0 bg-black/55" style={{ width: `${Math.max(0, min) * 100}%` }} />
            <span className="absolute inset-y-0 right-0 bg-black/55" style={{ width: `${Math.max(0, 1 - max) * 100}%` }} />
          </>
        ) : null}
        <span className="absolute -top-1 h-3.5 w-0.5 bg-cs2-text-primary shadow" style={{ left: `calc(${position}% - 1px)` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-cs2-text-muted"><span>{bounded ? min.toFixed(2) : "0.00"}</span><span className="font-bold text-cs2-text-secondary">{value.toFixed(6)}</span><span>{bounded ? max.toFixed(2) : "1.00"}</span></div>
    </div>
  );
}

function HoverDetails({ item, locale, position }) {
  const t = useT();
  const wear = finiteNumber(item?.paint_wear);
  const seed = finiteNumber(item?.paint_seed);
  const assetId = item?.item_id;
  const finishKnown = item?.finish_known !== false;
  return (
    <div
      role="tooltip"
      data-cosmetic-hover-card
      className="pointer-events-none fixed z-[120] w-72 border border-cs2-border bg-[#171b20]/[0.98] p-3 shadow-2xl backdrop-blur"
      style={{ left: position.x, top: position.y }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-cs2-border pb-2">
        <div className="min-w-0">
          {customName(item) ? <p className="truncate text-[12px] font-black text-cs2-text-primary">“{customName(item)}”</p> : null}
          <div className={customName(item) ? "mt-0.5" : ""}>
            <CraftNameLines item={item} locale={locale} />
          </div>
        </div>
        <TeamIndicators item={item} compact />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[9px]">
        <span className="text-cs2-text-muted">{t("analysis.cosmetics.type")}</span>
        <span className="text-right font-semibold text-cs2-text-secondary">{t(`analysis.cosmetics.type.${item?.type || "unknown"}`)}</span>
        {finishKnown && Number(item?.paint_index) > 0 ? <><span className="text-cs2-text-muted">{t("analysis.cosmetics.paintIndex")}</span><span className="text-right font-mono font-semibold text-cs2-text-secondary">{Number(item.paint_index)}</span></> : null}
        {seed !== null ? <><span className="text-cs2-text-muted">{t("analysis.cosmetics.seed")}</span><span className="text-right font-mono font-semibold text-cs2-text-secondary">{Math.trunc(seed)}</span></> : null}
        {assetId ? <><span className="text-cs2-text-muted">{t("analysis.cosmetics.assetId")}</span><span className="truncate text-right font-mono font-semibold text-cs2-text-secondary">{assetId}</span></> : null}
      </div>
      {!finishKnown ? <div className="mt-2 border border-amber-400/25 bg-amber-400/10 px-2 py-1.5 text-[9px] leading-relaxed text-amber-200">{t("analysis.cosmetics.finishUnavailable")}</div> : null}
      {wear !== null ? (
        <div className="mt-2 border-t border-cs2-border pt-2">
          <div className="flex items-center justify-between text-[9px]"><span className="text-cs2-text-muted">{t("analysis.cosmetics.exterior")}</span><span className="font-semibold text-cs2-text-secondary">{t(`analysis.cosmetics.exterior.${exteriorKey(wear)}`)}</span></div>
          <WearBar wear={wear} wearMin={item?.wear_min} wearMax={item?.wear_max} compact />
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ label, children }) {
  if (children === undefined || children === null || children === "") return null;
  return (
    <div className="grid grid-cols-[108px_minmax(0,1fr)] gap-3 border-b border-cs2-border-subtle py-2 text-[11px] last:border-b-0">
      <dt className="text-cs2-text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-semibold text-cs2-text-secondary">{children}</dd>
    </div>
  );
}

function ItemDetail({ item, locale, onlineAssetsEnabled, onOpen3d, onCopyInspectUrl, inspectBusy }) {
  const t = useT();
  const stickers = Array.isArray(item?.stickers) ? item.stickers : [];
  const observed = Array.isArray(item?.observed_teams) ? item.observed_teams : [];
  const compatible = eligibleTeams(item);
  const description = localized(item, "desc", locale);
  const collection = localized(item, "collection_name", locale);
  const rarityKey = RARITY_NAMES[String(item?.rarity || "").toLowerCase()] || "unknown";
  const wear = finiteNumber(item?.paint_wear);
  const seed = finiteNumber(item?.paint_seed);
  const finishKnown = item?.finish_known !== false;
  return (
    <div className="grid min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
      <div className="flex flex-col items-center justify-center gap-4 border-b border-cs2-border bg-cs2-bg-page/55 p-5 lg:border-b-0 lg:border-r">
        {onlineAssetsEnabled && collection && item?.collection_image_url ? (
          <div className="flex items-center gap-2 self-start text-[11px] text-cs2-text-secondary">
            <img src={item.collection_image_url} alt="" className="h-8 w-8 object-contain" />
            <span>{collection}</span>
          </div>
        ) : null}
        <CosmeticImage item={item} onlineAssetsEnabled={onlineAssetsEnabled} className="max-h-[300px] w-full" />
        {stickers.length && onlineAssetsEnabled ? (
          <div className="flex w-full flex-wrap justify-center gap-4">
            {stickers.map((sticker, index) => (
              <div key={`${sticker?.catalog_id || "sticker"}-${index}`} className="w-[5.5rem] text-center">
                <img src={sticker?.image_url} alt="" className="mx-auto h-20 w-20 object-contain" />
                <span className="mt-1.5 block break-words text-[9px] leading-snug text-cs2-text-muted">
                  {localized(sticker, "name", locale)}
                </span>
              </div>
            ))}
          </div>
        ) : stickers.length ? (
          <div className="inline-flex items-center gap-1.5 text-[10px] text-cs2-text-muted"><WifiOff className="h-3.5 w-3.5" />{t("analysis.cosmetics.onlineAssetsOff")}</div>
        ) : (
          <div className="inline-flex items-center gap-1.5 text-[10px] text-cs2-text-muted"><Sticker className="h-3.5 w-3.5" />{t("analysis.cosmetics.noStickerEvidence")}</div>
        )}
      </div>
      <div className="min-w-0 p-5">
        <div className="mb-4 border-b border-cs2-border pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {customName(item) ? <p className="break-words text-base font-black text-cs2-text-primary">“{customName(item)}”</p> : null}
              <div className={customName(item) ? "mt-1" : ""}>
                <CraftNameLines item={item} locale={locale} />
              </div>
            </div>
            <TeamIndicators item={item} />
          </div>
          <div className="mt-3 h-1" style={{ backgroundColor: item?.rarity || "#ded6cc" }} />
        </div>
        <dl>
          <DetailRow label={t("analysis.cosmetics.type")}>{t(`analysis.cosmetics.type.${item?.type || "unknown"}`)}</DetailRow>
          <DetailRow label={t("analysis.cosmetics.rarity")}><span style={{ color: item?.rarity }}>{t(`analysis.cosmetics.rarity.${rarityKey}`)}</span></DetailRow>
          {wear !== null ? <DetailRow label={t("analysis.cosmetics.exterior")}>{t(`analysis.cosmetics.exterior.${exteriorKey(wear)}`)}</DetailRow> : null}
          <DetailRow label={t("analysis.cosmetics.observedTeams")}>{observed.length ? observed.map((team) => team.toUpperCase()).join(" + ") : t("analysis.cosmetics.notObserved")}</DetailRow>
          <DetailRow label={t("analysis.cosmetics.compatibleTeams")}>{compatible.length ? compatible.map((team) => team.toUpperCase()).join(" + ") : t("analysis.cosmetics.notApplicable")}</DetailRow>
          <DetailRow label={t("analysis.cosmetics.definitionIndex")}>{Number(item?.def_index)}</DetailRow>
          {finishKnown && Number(item?.paint_index) > 0 ? <DetailRow label={t("analysis.cosmetics.paintIndex")}>{Number(item.paint_index)}</DetailRow> : null}
          {seed !== null ? <DetailRow label={t("analysis.cosmetics.seed")}>{Math.trunc(seed)}</DetailRow> : null}
          <DetailRow label={t("analysis.cosmetics.assetId")}><span className="font-mono">{item?.item_id}</span></DetailRow>
        </dl>
        {!finishKnown ? <div className="mt-3 border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[10px] leading-relaxed text-amber-200">{t("analysis.cosmetics.finishUnavailable")}</div> : null}
        <WearBar wear={wear} wearMin={item?.wear_min} wearMax={item?.wear_max} />
        {description ? <p className="mt-4 whitespace-pre-line border-t border-cs2-border pt-4 text-[11px] leading-relaxed text-cs2-text-secondary">{description}</p> : null}
        <div className="mt-5 grid grid-cols-2 border border-cs2-border">
          <button data-cosmetic-open-3d type="button" disabled={!canInspect3d(item, onlineAssetsEnabled)} onClick={onOpen3d} className="inline-flex h-10 items-center justify-center gap-2 border-r border-cs2-border text-[11px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-35"><Rotate3D className="h-4 w-4" />{t("analysis.cosmetics.inspect3d")}</button>
          <button type="button" disabled={!canInspectInGame(item) || inspectBusy} onClick={onCopyInspectUrl} className="inline-flex h-10 items-center justify-center gap-2 text-[11px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-35"><Copy className="h-4 w-4" />{t("analysis.cosmetics.copyInspectUrl")}</button>
        </div>
      </div>
    </div>
  );
}

export default function CosmeticsView({ workspace, selectedPlayer, locale = "zh", onlineAssetsEnabled = false, demoId = null }) {
  const t = useT();
  const name = playerName(selectedPlayer);
  const workspacePlayer = useMemo(() => {
    const target = name.toLocaleLowerCase();
    return (workspace?.players || []).find((player) => playerName(player).toLocaleLowerCase() === target) || null;
  }, [name, workspace?.players]);
  const steamid = steamIdForPlayer(workspacePlayer) || steamIdForPlayer(selectedPlayer);
  const [detail, setDetail] = useState(null);
  const [hoverCard, setHoverCard] = useState(null);
  const [notice, setNotice] = useState(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [viewMode, setViewMode] = useState("browse");
  const [localReplacements, setLocalReplacements] = useState({});
  const [savedReplacements, setSavedReplacements] = useState({});
  const [originalBySlot, setOriginalBySlot] = useState({});
  const [savedOriginals, setSavedOriginals] = useState({});
  const [pickerItem, setPickerItem] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [teamTab, setTeamTab] = useState("ct");
  const inventory = useMemo(() => {
    const rows = workspace?.cosmetics?.players?.[steamid];
    return Array.isArray(rows) ? rows : [];
  }, [steamid, workspace?.cosmetics?.players]);
  const ctItems = useMemo(
    () => mergeLoadoutWithEvidence(listDefaultLoadout("ct"), itemsForTeam(inventory, "ct"), locale),
    [inventory, locale],
  );
  const tItems = useMemo(
    () => mergeLoadoutWithEvidence(listDefaultLoadout("t"), itemsForTeam(inventory, "t"), locale),
    [inventory, locale],
  );
  const activeTeam = teamTab === "t" ? "t" : "ct";
  const activeItems = activeTeam === "t" ? tItems : ctItems;
  const browseMode = viewMode === "browse";
  const hasReplacements = Object.keys(localReplacements).length > 0;
  const canSavePlan = Boolean(demoId) && hasReplacements && !saving;

  const clearOverlays = () => {
    setDetail(null);
    setHoverCard(null);
    setPickerItem(null);
  };

  useEffect(() => {
    setDetail(null);
    setHoverCard(null);
    setNotice(null);
    setViewMode("browse");
    setLocalReplacements({});
    setSavedReplacements({});
    setOriginalBySlot({});
    setSavedOriginals({});
    setPickerItem(null);
    setSaving(false);
    setSaveResult(null);
  }, [demoId, steamid]);

  useEffect(() => {
    setTeamTab("ct");
  }, [steamid]);

  useEffect(() => {
    if (!demoId || !steamid) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await loadCustomSkinPlan({ demoId, steamid });
        if (cancelled) return;
        const seeded = replacementsFromPlan(data?.plan);
        const originals = originalsFromPlan(data?.plan);
        setSavedReplacements(seeded || {});
        setLocalReplacements(seeded || {});
        setSavedOriginals(originals);
        setOriginalBySlot(originals);
      } catch {
        // Keep empty local state when load fails; user can still customize.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demoId, steamid]);

  useEffect(() => {
    if (!hoverCard) return undefined;
    const close = () => setHoverCard(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [hoverCard]);

  const openHover = (event, item) => {
    if (!browseMode || detail) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 288;
    const estimatedHeight = 230;
    const x = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
    const below = rect.bottom + 8;
    const y = below + estimatedHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, rect.top - estimatedHeight - 8);
    setHoverCard({ item, position: { x, y } });
  };

  const writeClipboard = async (text) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand?.("copy");
    textarea.remove();
    if (!copied) throw new Error("Clipboard API unavailable");
  };

  const copyInspectUrl = async (item) => {
    setInspectBusy(true);
    try {
      const { buildCs2InspectLink } = await import("../../utils/cs2Inspect.js");
      await writeClipboard(buildCs2InspectLink(item));
      setNotice({ tone: "success", text: t("analysis.cosmetics.inspectUrlCopied") });
    } catch {
      setNotice({ tone: "error", text: t("analysis.cosmetics.inspectFailed") });
    } finally {
      setInspectBusy(false);
    }
  };

  const openItemDetail = (item) => {
    if (!browseMode) return;
    setHoverCard(null);
    setDetail({ item, mode: "info" });
  };

  const openCard = (item, previewItem) => {
    if (browseMode) {
      openItemDetail(previewItem || item);
      return;
    }
    if (isCustomizable(item)) {
      setPickerItem(item);
    }
  };

  const cancelCustomize = () => {
    setLocalReplacements({ ...savedReplacements });
    setOriginalBySlot({ ...savedOriginals });
    clearOverlays();
    setViewMode("browse");
  };

  const confirmReplacement = (replacement) => {
    if (!pickerItem) return;
    const key = slotKey(pickerItem);
    setOriginalBySlot((prev) => {
      if (prev[key]) return prev;
      // Row map may already show the preview skin; prefer the live inventory row.
      const evidence = inventory.find((row) => slotKey(row) === key) || pickerItem;
      const pending = localReplacements[key];
      if (pending && !pending.restore) {
        const paintMatches = Number(evidence?.paint_index) === Number(pending.paint_index)
          && Number(evidence?.def_index) === Number(pending.def_index);
        // Inventory already equals the customized skin — do not treat it as the demo original.
        if (paintMatches) return prev;
      }
      return { ...prev, [key]: snapshotOriginalItem(evidence) };
    });
    setLocalReplacements((prev) => ({ ...prev, [key]: replacement }));
    setPickerItem(null);
  };

  const clearReplacement = (key) => {
    const slot = String(key || "").trim();
    if (!slot) return;
    const snapshot = originalBySlot[slot];
    const restore = restoreReplacementFromSnapshot(snapshot);
    if (!restore) {
      // No snapshot — drop the pending replacement only.
      setLocalReplacements((prev) => {
        if (!(slot in prev)) return prev;
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      return;
    }
    // Keep the slot in replacements so save posts the original skin back to skin-core.
    setLocalReplacements((prev) => ({ ...prev, [slot]: restore }));
  };

  const savePlan = async () => {
    if (!canSavePlan) return;
    setSaving(true);
    setNotice({ tone: "info", text: t("analysis.cosmetics.savingPlan") });
    try {
      const result = await saveCustomSkinPlan({
        demoId,
        steamid,
        replacements: replacementsForApi(localReplacements),
        originals: originalBySlot,
      });
      const succeeded = enrichSaveResultRows(
        Array.isArray(result?.succeeded) ? result.succeeded : [],
        inventory,
        localReplacements,
      );
      const failed = enrichSaveResultRows(
        Array.isArray(result?.failed) ? result.failed : [],
        inventory,
        localReplacements,
      );
      const hasItemResults = succeeded.length > 0 || failed.length > 0;

      if (hasItemResults) {
        setSaveResult({
          ok: Boolean(result?.ok),
          partial: Boolean(result?.partial) || (succeeded.length > 0 && failed.length > 0),
          succeeded,
          failed,
          error: result?.error || null,
        });
      }

      if (result?.ok) {
        const seeded = replacementsFromPlan(result?.plan) || {};
        const fromPlan = originalsFromPlan(result?.plan);
        // Prefer in-session first-seen originals over plan rows (inventory may already be the new skin).
        const originals = mergeOriginalsPreferExisting(fromPlan, originalBySlot);
        setSavedReplacements(seeded);
        setSavedOriginals(originals);
        if (failed.length > 0) {
          const failedKeys = new Set(failed.map((row) => row?.slot_key).filter(Boolean));
          setLocalReplacements((prev) =>
            Object.fromEntries(Object.entries(prev).filter(([key]) => failedKeys.has(key))),
          );
          setOriginalBySlot((prev) =>
            Object.fromEntries(Object.entries(prev).filter(([key]) => failedKeys.has(key))),
          );
          setNotice({ tone: "info", text: t("analysis.cosmetics.savePartial") });
        } else {
          setLocalReplacements(seeded);
          setOriginalBySlot(originals);
          setNotice({ tone: "success", text: t("analysis.cosmetics.saveSuccess") });
          clearOverlays();
          setViewMode("browse");
        }
      } else {
        setNotice({
          tone: "error",
          text: result?.error || t("analysis.cosmetics.saveFailed"),
        });
      }
    } catch (error) {
      setNotice({
        tone: "error",
        text: error?.message || t("analysis.cosmetics.saveFailed"),
      });
    } finally {
      setSaving(false);
    }
  };

  const open3d = (item) => {
    setHoverCard(null);
    setDetail({ item, mode: "3d" });
  };

  if (!selectedPlayer || !steamid) {
    return (
      <div className="flex min-h-[360px] items-center justify-center border border-dashed border-cs2-border bg-cs2-bg-page/35 p-8 text-center">
        <div><Gem className="mx-auto h-7 w-7 text-cs2-text-muted" /><h2 className="mt-3 text-[13px] font-bold">{t("analysis.cosmetics.pickPlayer")}</h2><p className="mt-1 text-[11px] text-cs2-text-muted">{t("analysis.cosmetics.pickPlayerHint")}</p></div>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-cs2-border pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><Gem className="h-4 w-4 text-cs2-accent" /><h2 className="truncate text-[13px] font-black text-cs2-text-primary">{t("analysis.cosmetics.title", { name })}</h2></div>
          <p className="mt-1 text-[10px] text-cs2-text-muted">{t("analysis.cosmetics.ownershipHint")} · {t("analysis.cosmetics.interactionHint")}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {browseMode ? (
            <button
              type="button"
              data-testid="cosmetics-customize"
              onClick={() => {
                clearOverlays();
                setViewMode("custom");
              }}
              className="inline-flex h-8 items-center gap-1.5 border border-cs2-border bg-cs2-bg-input px-3 text-[10px] font-bold text-cs2-text-secondary hover:border-cs2-text-muted hover:text-cs2-text-primary"
            >
              {t("analysis.cosmetics.customize")}
            </button>
          ) : (
            <>
              <p className="text-[10px] text-cs2-text-muted">
                {saving
                  ? t("analysis.cosmetics.savingPlan")
                  : !demoId
                    ? t("analysis.cosmetics.saveNeedsDemo")
                    : t("analysis.cosmetics.customizingHint")}
              </p>
              <button
                type="button"
                disabled={saving}
                onClick={cancelCustomize}
                className="inline-flex h-8 items-center border border-cs2-border px-3 text-[10px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("analysis.cosmetics.cancelCustomize")}
              </button>
              <button
                type="button"
                data-testid="cosmetics-save-plan"
                disabled={!canSavePlan}
                aria-busy={saving}
                onClick={() => void savePlan()}
                className="inline-flex h-8 items-center gap-1.5 border border-cs2-accent/40 bg-cs2-accent/10 px-3 text-[10px] font-bold text-cs2-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                {saving ? t("analysis.cosmetics.savingPlan") : t("analysis.cosmetics.savePlan")}
              </button>
            </>
          )}
        </div>
      </div>

      {notice ? (
        <div className={`mb-3 flex items-center gap-2 border px-3 py-2 text-[10px] ${
          notice.tone === "error"
            ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
            : notice.tone === "info"
              ? "border-sky-500/35 bg-sky-500/10 text-sky-200"
              : "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
        }`}>
          {notice.tone === "error"
            ? <Info className="h-3.5 w-3.5" />
            : notice.tone === "info"
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Check className="h-3.5 w-3.5" />}
          {notice.text}
        </div>
      ) : null}

      {!onlineAssetsEnabled ? (
        <div className="mb-3 flex items-center gap-2 border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[10px] text-cs2-text-muted"><WifiOff className="h-3.5 w-3.5" />{t("analysis.cosmetics.onlineAssetsOff")}</div>
      ) : null}

      <div
        role="tablist"
        aria-label={t("analysis.cosmetics.teamTabs")}
        className="mb-4 inline-flex rounded border border-cs2-border bg-cs2-bg-input p-0.5"
      >
        {["ct", "t"].map((team) => {
          const active = activeTeam === team;
          const count = team === "ct" ? ctItems.length : tItems.length;
          return (
            <button
              key={team}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`cosmetics-team-tab-${team}`}
              onClick={() => {
                setHoverCard(null);
                setTeamTab(team);
              }}
              className={`inline-flex h-8 min-w-[4.5rem] items-center justify-center gap-1.5 px-3 text-[11px] font-black uppercase tracking-wide transition-colors ${
                active
                  ? team === "ct"
                    ? "bg-sky-500/20 text-sky-200"
                    : "bg-amber-500/20 text-amber-200"
                  : "text-cs2-text-muted hover:text-cs2-text-secondary"
              }`}
            >
              <span>{t(`analysis.cosmetics.team.${team}`)}</span>
              <span className={`font-mono text-[10px] font-semibold ${active ? "opacity-90" : "opacity-60"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      <CosmeticsTeamRow
        team={activeTeam}
        items={activeItems}
        locale={locale}
        onlineAssetsEnabled={onlineAssetsEnabled}
        customMode={!browseMode}
        localReplacements={localReplacements}
        originalBySlot={originalBySlot}
        showHeading={false}
        onOpen={openCard}
        onHoverStart={openHover}
        onHoverEnd={() => setHoverCard(null)}
        onClearReplacement={browseMode ? null : clearReplacement}
      />

      {hoverCard ? <HoverDetails item={hoverCard.item} locale={locale} position={hoverCard.position} /> : null}

      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail ? (customName(detail.item) || displayName(detail.item, locale)) : ""}
        subtitle={detail?.mode === "3d" ? t("analysis.cosmetics.inspect3d") : localized(detail?.item, "collection_name", locale) || t("analysis.cosmetics.itemInfo")}
        icon={detail?.mode === "3d" ? <Rotate3D className="h-4 w-4 text-cs2-accent" /> : <Gem className="h-4 w-4 text-cs2-accent" />}
        maxWidth="max-w-6xl"
        maxHeight="max-h-[90vh]"
        className={detail?.mode === "3d" ? "" : "!h-auto"}
        contentClassName={detail?.mode === "3d" ? "flex-1 overflow-y-auto" : "overflow-y-auto"}
        headerRight={detail?.mode === "3d" ? <button type="button" onClick={() => setDetail({ item: detail.item, mode: "info" })} className="inline-flex items-center gap-1 text-[10px] font-semibold text-cs2-text-muted hover:text-cs2-text-primary"><ChevronLeft className="h-3.5 w-3.5" />{t("analysis.cosmetics.backToInfo")}</button> : null}
      >
        {detail?.mode === "3d" ? (
          <div
            data-cosmetic-inspect-stage
            className="bg-[radial-gradient(circle_at_50%_42%,rgba(255,117,24,0.10),transparent_38%),linear-gradient(180deg,#101419_0%,#080a0d_100%)]"
          >
            <iframe title={t("analysis.cosmetics.inspect3d")} src={viewerUrl(detail.item)} className="h-[72vh] w-full border-0 bg-transparent" allow="fullscreen" />
          </div>
        ) : detail ? (
          <ItemDetail item={detail.item} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} onOpen3d={() => open3d(detail.item)} onCopyInspectUrl={() => void copyInspectUrl(detail.item)} inspectBusy={inspectBusy} />
        ) : null}
      </Modal>

      <SkinReplacementPicker
        open={Boolean(pickerItem)}
        sourceItem={pickerItem}
        locale={locale}
        onlineAssetsEnabled={onlineAssetsEnabled}
        onClose={() => setPickerItem(null)}
        onConfirm={confirmReplacement}
      />

      <Modal
        open={Boolean(saveResult)}
        onClose={() => setSaveResult(null)}
        title={t("analysis.cosmetics.saveResultTitle")}
        icon={<Gem className="h-4 w-4 text-cs2-accent" />}
        maxWidth="max-w-md"
        maxHeight="max-h-[70vh]"
        className="!h-auto"
        contentClassName="overflow-y-auto"
        footer={(
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              data-testid="cosmetics-save-result-close"
              onClick={() => setSaveResult(null)}
            >
              {t("analysis.cosmetics.saveResultClose")}
            </Button>
          </div>
        )}
      >
        {saveResult ? (
          <div className="space-y-4 px-5 py-4" data-testid="cosmetics-save-result">
            {saveResult.error ? (
              <p className="text-[12px] leading-relaxed text-cs2-rose-on-surface">{saveResult.error}</p>
            ) : null}
            <div>
              <p className="mb-2 text-[11px] font-semibold text-cs2-text-muted">
                {t("analysis.cosmetics.saveResultSucceeded", { count: saveResult.succeeded.length })}
              </p>
              {saveResult.succeeded.length ? (
                <ul className="max-h-48 space-y-2 overflow-y-auto">
                  {saveResult.succeeded.map((row) => {
                    const from = saveResultOriginalName(row, locale);
                    const to = saveResultReplacementName(row, locale);
                    return (
                      <li key={`ok-${row.slot_key || row.item_id64}`} className="text-[12px] leading-snug">
                        {from ? (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <span className="text-cs2-text-muted">{from}</span>
                            <ArrowRight className="h-3 w-3 shrink-0 text-cs2-text-muted" aria-hidden />
                            <span className="font-medium text-cs2-text-primary">{to}</span>
                          </span>
                        ) : (
                          <span className="font-medium text-cs2-text-primary">{to}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[12px] text-cs2-text-muted">{t("analysis.cosmetics.saveResultEmpty")}</p>
              )}
            </div>
            <div>
              <p className="mb-2 text-[11px] font-semibold text-cs2-text-muted">
                {t("analysis.cosmetics.saveResultFailed", { count: saveResult.failed.length })}
              </p>
              {saveResult.failed.length ? (
                <ul className="max-h-48 space-y-2 overflow-y-auto">
                  {saveResult.failed.map((row) => {
                    const from = saveResultOriginalName(row, locale);
                    const to = saveResultReplacementName(row, locale);
                    return (
                      <li key={`fail-${row.slot_key || row.item_id64}`} className="text-[12px] leading-snug">
                        {from ? (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <span className="text-cs2-text-muted">{from}</span>
                            <ArrowRight className="h-3 w-3 shrink-0 text-cs2-text-muted" aria-hidden />
                            <span className="font-medium text-cs2-text-primary">{to}</span>
                          </span>
                        ) : (
                          <span className="font-medium text-cs2-text-primary">{to}</span>
                        )}
                        {row.error ? (
                          <span className="mt-0.5 block text-cs2-text-muted">— {row.error}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[12px] text-cs2-text-muted">{t("analysis.cosmetics.saveResultEmpty")}</p>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
