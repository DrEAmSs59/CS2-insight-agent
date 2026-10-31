/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import CosmeticAttachmentSummary from "../../cosmetics-workshop/CosmeticAttachmentSummary.jsx";
import { cosmeticInspectLink } from "../../cosmetics-workshop/CosmeticInspectActions.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, ChevronLeft, Copy, Gamepad2, Gem, Info, Loader2, MousePointerClick, PackageOpen, RefreshCw, Rotate3D, Sticker, WifiOff, X } from "lucide-react";
import { desktopBridge } from "../../../desktop/desktopBridge.js";
import { useT } from "../../../i18n/useT.js";
import { buildCs2ViewerUrl, launchCs2Inspect } from "../../../utils/cs2Inspect.js";
import { launchCs2InspectOnHost } from "../../../api/cs2InspectApi.js";
import { steamIdForPlayer } from "../../../utils/playerAppearance.js";
import { playerIdentityKey } from "../../../utils/playerIdentity.js";
import Modal from "../../../components/ui/Modal";
import Cs2LoadingAnimation from "../../../components/Cs2LoadingAnimation.jsx";
import Button from "../../../components/ui/Button";
import { AccentButton, EmptyState, FocusedPlayerHeader, TipStrip } from "../AnalysisUi.jsx";
import { craftNameParts, formatCraftPipeName, imageUrlForWear, listDefaultLoadout } from "./cosmeticsCatalog.js";
import { isCustomizable, itemsForTeam, mergeLoadoutWithEvidence, slotKey, sortCosmeticsForRow, teamSlotKey } from "./cosmeticsLayout.js";
import { originalCosmeticName, replacementCosmeticName } from "../../cosmetics-workshop/cosmeticNames.js";
import PlayerLoadoutEditor, { loadoutCandidates } from "./PlayerLoadoutEditor.jsx";
import SkinReplacementPicker from "./SkinReplacementPicker.jsx";
import { saveCustomSkinPlan, loadCustomSkinPlan } from "./saveCustomSkinPlan.js";
import { readWorkshopSchemes, workshopSchemeSelectionCount, workshopSchemeSelectionForItem } from "../../cosmetics-workshop/workshopSchemeStorage.js";
function sameCosmeticIdentity(item, replacement) {
  if (!item || !replacement) return false;
  const itemType = String(item?.type || "");
  const replacementType = String(replacement?.type || "");
  if (itemType && replacementType && itemType !== replacementType) return false;
  const itemCatalog = Number(item?.catalog_id);
  const replacementCatalog = Number(replacement?.catalog_id);
  const catalogMatches = Number.isFinite(replacementCatalog) && replacementCatalog > 0 && Number.isFinite(itemCatalog) && itemCatalog > 0 && itemCatalog === replacementCatalog;
  const definitionMatches = Number(item?.def_index) === Number(replacement?.def_index) && (Number(item?.paint_index) || 0) === (Number(replacement?.paint_index) || 0);
  return catalogMatches || definitionMatches;
}
function planRowSlotKeys(row, inventory = []) {
  let key = String(row?.slot_key || "").trim();
  if (!key) return [];
  const oldId = key.match(/^(?:(?:t|ct):)?id:(\d+)$/i)?.[1];
  const originalKey = slotKey(row?.original);
  if (oldId && originalKey.startsWith("id:") && Number(oldId) === Number(row?.original?.item_id)) {
    key = key.replace(/id:\d+$/, originalKey);
  }
  const scopedTeam = key.match(/^(t|ct):/i)?.[1]?.toLowerCase() || null;
  const baseKey = scopedTeam ? key.replace(/^(?:t|ct):/i, "") : key;
  const keys = [];
  if (scopedTeam) keys.push(key.toLowerCase());
  const originalTeams = Array.isArray(row?.original?.observed_teams) ? row.original.observed_teams : [];
  const inventoryItem = inventory.find(item => slotKey(item) === baseKey);
  const observed = originalTeams.length ? originalTeams : inventoryItem?.observed_teams || [];
  const teams = [...new Set(observed.map(team => String(team || "").toLowerCase()))].filter(team => team === "t" || team === "ct");
  if (!scopedTeam) keys.push(...(teams.length ? teams.map(team => `${team}:${key}`) : [key]));

  // Materialization may assign a synthetic item ID to a zero-ID weapon or to a
  // side-scoped glove. After re-analysis that replacement has a different slot
  // key from the persisted original. Alias the plan onto the uniquely observed
  // replacement entity for the same side so cards keep rendering
  // "demo original → replacement" instead of only the applied skin.
  const replacement = row?.replacement;
  if (replacement && typeof replacement === "object") {
    const targetTeams = scopedTeam ? [scopedTeam] : teams;
    for (const team of targetTeams) {
      const candidates = inventory.filter(item => {
        const observedTeams = (Array.isArray(item?.observed_teams) ? item.observed_teams : []).map(entry => String(entry || "").toLowerCase());
        return observedTeams.includes(team) && sameCosmeticIdentity(item, replacement);
      });
      const exact = candidates.find(item => slotKey(item) === baseKey);
      // Do not guess when two unrelated inventory entities have the same finish
      // on one side. The persisted key remains available for an exact match.
      const applied = exact || (candidates.length === 1 ? candidates[0] : null);
      if (applied) keys.push(teamSlotKey(applied, team));
    }
  }
  return [...new Set(keys)];
}
function replacementsFromPlan(plan, inventory = []) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (!items.length) return null;
  const next = {};
  for (const row of items) {
    if (!row?.replacement || typeof row.replacement !== "object") continue;
    for (const key of planRowSlotKeys(row, inventory)) next[key] = row.replacement;
  }
  return Object.keys(next).length ? next : null;
}

/** Original demo skins stored in a custom plan (survives post-apply inventory drift). */
function originalsFromPlan(plan, inventory = []) {
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (!items.length) return {};
  const next = {};
  for (const row of items) {
    if (!row?.original || typeof row.original !== "object") continue;
    for (const key of planRowSlotKeys(row, inventory)) {
      const scopedTeam = key.match(/^(t|ct):/i)?.[1]?.toLowerCase();
      next[key] = scopedTeam ? {
        ...row.original,
        observed_teams: [scopedTeam]
      } : row.original;
    }
  }
  return next;
}
function cosmeticPreview(item, replacement) {
  if (!replacement) return item;
  return {
    ...item,
    ...replacement,
    // Empty sticker/charm edits clear them; an empty name uses the original.
    ...{},
    ...{},
    custom_name: replacementCosmeticName(item, replacement),
    image_url: replacement.image_url || item?.image_url,
    rarity: replacement.rarity || item?.rarity,
    paint_wear: Number.isFinite(Number(replacement.paint_wear)) ? Number(replacement.paint_wear) : item?.paint_wear,
    paint_index: Number.isFinite(Number(replacement.paint_index)) ? Number(replacement.paint_index) : item?.paint_index,
    is_placeholder: false,
    is_base: false,
    finish_known: replacement.finish_known !== false
  };
}

/** Restore the complete original look, including imported attachment transforms. */
function restoreOriginalVisual(item, snapshot) {
  if (!snapshot) return {
    ...item,
    custom_name: originalCosmeticName(item)
  };
  return {
    ...item,
    ...snapshot,
    image_url: snapshot.image_url || item?.image_url,
    ...{},
    custom_name: originalCosmeticName(snapshot, item),
    item_id: item?.item_id
  };
}
function snapshotOriginalItem(item, team = null) {
  const scopedTeam = String(team || "").toLowerCase();
  return {
    ...{},
    stickers: structuredClone(item?.stickers || []),
    keychain: structuredClone(Object.hasOwn(item || {}, "keychain") ? item.keychain : item?.keychains?.[0] ?? null),
    item_id: item?.item_id,
    type: item?.type,
    def_index: item?.def_index,
    paint_index: item?.paint_index,
    paint_seed: item?.paint_seed,
    paint_wear: item?.paint_wear,
    wear_min: item?.wear_min,
    wear_max: item?.wear_max,
    name_zh: item?.name_zh,
    name_en: item?.name_en,
    alt_name: item?.alt_name,
    image_url: item?.image_url,
    rarity: item?.rarity,
    // Persist an explicit empty string. JSON drops `undefined`, which made old
    // plans unable to distinguish "the original had no tag" from "unknown".
    custom_name: originalCosmeticName(item),
    finish_known: item?.finish_known,
    is_base: item?.is_base,
    is_placeholder: item?.is_placeholder,
    catalog_id: item?.catalog_id,
    model: item?.model,
    // Required for zero-id glove materialize (T/CT). Default loadout placeholders
    // set this; dropping it makes both sides land as team ANY and soft-fail.
    observed_teams: scopedTeam === "t" || scopedTeam === "ct" ? [scopedTeam] : Array.isArray(item?.observed_teams) ? [...item.observed_teams] : item?.observed_teams
  };
}
function workshopSchemeDraft(plan, teamItems, originalBySlot) {
  const replacements = {};
  const originals = {
    ...(originalBySlot || {})
  };
  for (const team of ["ct", "t"]) {
    for (const item of teamItems?.[team] || []) {
      if (!isCustomizable(item)) continue;
      const replacement = workshopSchemeSelectionForItem(plan, team, item);
      if (!replacement) continue;
      const key = teamSlotKey(item, team);
      replacements[key] = replacement;
      if (!originals[key]) originals[key] = snapshotOriginalItem(item, team);
    }
  }
  return {
    replacements,
    originals
  };
}

/** Keep first-seen demo originals; never let a later plan overwrite them with the new skin. */
function mergeOriginalsPreferExisting(fromPlan, existing) {
  const next = {
    ...(fromPlan || {})
  };
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
    ...{},
    catalog_id: snapshot.catalog_id,
    def_index: snapshot.def_index,
    paint_index: Number.isFinite(paintIndex) ? paintIndex : 0,
    paint_seed: Number.isFinite(paintSeed) ? Math.trunc(paintSeed) : 0,
    paint_wear: Number.isFinite(paintWear) ? paintWear : 0,
    wear_min: snapshot.wear_min,
    wear_max: snapshot.wear_max,
    model: snapshot.model,
    type: snapshot.type,
    name_en: snapshot.name_en,
    name_zh: snapshot.name_zh,
    alt_name: snapshot.alt_name,
    image_url: snapshot.image_url,
    rarity: snapshot.rarity,
    finish_known: snapshot.finish_known,
    restore: true,
    // Rewrites start from the original Demo, whose attachment data is more
    // complete than the inventory preview. An empty patch preserves it exactly.
    ...(["weapon", "melee"].includes(snapshot.type) ? {} : {})
  };
}

/** Drop UI-only flags before posting replacements to the API. */
function replacementsForApi(replacements) {
  const out = {};
  for (const [key, value] of Object.entries(replacements || {})) {
    if (!value || typeof value !== "object") continue;
    const {
      restore: _restore,
      ...rest
    } = value;
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
  "#e4ae39": "contraband"
};
function playerName(player) {
  return String(player?.name || player?.player_name || "").trim();
}
function isVisibleCosmeticEvidence(item) {
  const type = String(item?.type || "").toLowerCase();
  const model = String(item?.model || "").toLowerCase();
  return type !== "agent" && type !== "musickit" && model !== "c4" && Number(item?.def_index) !== 49;
}
function localized(item, field, locale) {
  const chinese = String(item?.[`${field}_zh`] || "").trim();
  const english = String(item?.[`${field}_en`] || "").trim();
  return String(locale || "").toLowerCase().startsWith("zh") ? chinese || english : english || chinese;
}
function displayName(item, locale) {
  return localized(item, "name", locale) || String(item?.model || "CS2");
}
function rewriteOperationRows(replacements, originals, inventory, locale) {
  return Object.entries(replacements || {}).flatMap(([key, replacement]) => {
    if (!replacement || typeof replacement !== "object") return [];
    const baseKey = String(key).replace(/^(?:t|ct):/i, "");
    const inventoryItem = (inventory || []).find(item => slotKey(item) === baseKey) || null;
    const original = originals?.[key] || originals?.[baseKey] || inventoryItem;
    const target = replacement.restore ? original : replacement;
    const from = formatCraftPipeName(original || inventoryItem, locale) || displayName(original || inventoryItem, locale);
    const to = formatCraftPipeName(target, locale) || displayName(target, locale);
    return from && to ? [{
      key,
      from,
      to
    }] : [];
  });
}
function SkinRewriteOverlay({
  player,
  operations
}) {
  const t = useT();
  const rootRef = useRef(null);
  const [operationIndex, setOperationIndex] = useState(0);
  const rows = Array.isArray(operations) ? operations : [];
  const current = rows[operationIndex % Math.max(rows.length, 1)] || null;
  useEffect(() => {
    rootRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const blockKeyboardNavigation = event => {
      if (["Tab", "Enter", " ", "Escape"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", blockKeyboardNavigation, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", blockKeyboardNavigation, true);
    };
  }, []);
  useEffect(() => {
    setOperationIndex(0);
    if (rows.length <= 1) return undefined;
    const interval = window.setInterval(() => {
      setOperationIndex(value => (value + 1) % rows.length);
    }, 2600);
    return () => window.clearInterval(interval);
  }, [rows.length]);
  if (typeof document === "undefined") return null;
  return createPortal(<div ref={rootRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-busy="true" aria-labelledby="skin-rewrite-progress-title" data-testid="skin-rewrite-overlay" className="fixed inset-0 z-[250] flex items-center justify-center bg-black/75 px-4 py-8 backdrop-blur-md outline-none" onContextMenu={event => event.preventDefault()}>
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-[var(--cs2-shadow-lg)]">
        <div className="flex items-center gap-3 border-b border-cs2-border px-5 py-4">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center">
            <Cs2LoadingAnimation />
          </span>
          <div className="min-w-0">
            <h2 id="skin-rewrite-progress-title" className="text-[15px] font-bold text-cs2-text-primary">
              {t("analysis.cosmetics.rewriteProgressTitle")}
            </h2>
            <p className="mt-0.5 truncate text-xs text-cs2-text-muted">
              {t("analysis.cosmetics.rewriteProgressPlayer", {
              player,
              count: rows.length
            })}
            </p>
          </div>
        </div>
        <div className="space-y-4 px-5 py-5">
          <div data-testid="skin-rewrite-operation" className="flex min-h-10 flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center text-[12px] font-semibold leading-relaxed text-cs2-text-primary">
            {current ? <>
                <span>{t("analysis.cosmetics.rewriteProgressPrefix")}</span>
                <span>{current.from}</span>
                <ArrowRight data-testid="skin-rewrite-arrow" className="h-3.5 w-3.5 shrink-0 text-cs2-accent" aria-hidden />
                <span>{current.to}</span>
              </> : t("analysis.cosmetics.savingPlan")}
          </div>
          <div role="progressbar" aria-label={t("analysis.cosmetics.rewriteProgressTitle")} className="h-2 overflow-hidden rounded-full bg-cs2-bg-input">
            <div className="h-full w-[40%] animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-cs2-accent to-cs2-accent-light" />
          </div>
          <p className="text-center text-xs leading-relaxed text-cs2-text-muted">
            {t("analysis.cosmetics.rewriteProgressHint")}
          </p>
        </div>
      </div>
    </div>, document.body);
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
  const fallbackId = String(row?.item_id64 || "").trim();
  // Never surface bare zero-id as a label (vanilla slots use item_id64 "0").
  const idLabel = fallbackId && fallbackId !== "0" ? fallbackId : "";
  if (String(locale || "").toLowerCase().startsWith("zh")) {
    return zh || en || idLabel;
  }
  return en || zh || idLabel;
}
function saveFailureMessage(result, t) {
  if (result?.error_code === "COSMETICS_SKIN_CORE_UNAVAILABLE") {
    return t("analysis.cosmetics.saveCoreUnavailable");
  }
  if (result?.error_code === "COSMETICS_DEMO_INCOMPLETE_FOR_SKIN_REWRITE") {
    return t("analysis.cosmetics.saveDemoIncomplete");
  }
  return t("analysis.cosmetics.saveFailedLogged");
}
function failedItemMessage(row, t) {
  if (!row?.error_code && !row?.error) return null;
  // Defense in depth for responses from older backends: never render raw native errors.
  return t("analysis.cosmetics.saveItemFailed");
}

/** Fill original/replacement names from local inventory when API omits them. */
function enrichSaveResultRows(rows, inventoryRows, replacements) {
  const bySlot = new Map();
  const byItemId = new Map();
  for (const item of inventoryRows || []) {
    const key = slotKey(item);
    if (key) bySlot.set(key, item);
    for (const team of Array.isArray(item?.observed_teams) ? item.observed_teams : []) {
      const scoped = String(team || "").toLowerCase();
      if (scoped === "t" || scoped === "ct") bySlot.set(teamSlotKey(item, scoped), item);
    }
    const id = String(item?.item_id ?? "").trim();
    if (id && id !== "0") byItemId.set(id, item);
  }
  return (Array.isArray(rows) ? rows : []).map(row => {
    const slot = String(row?.slot_key || "").trim();
    const itemId = String(row?.item_id64 || "").trim();
    let original = slot && bySlot.get(slot) || itemId && itemId !== "0" && byItemId.get(itemId) || null;
    if (!original && itemId === "0") {
      const def = Number(row?.definition_index);
      if (Number.isFinite(def) && def > 0) {
        original = (inventoryRows || []).find(item => Number(item?.def_index) === def) || null;
      }
    }
    const replacement = slot && replacements?.[slot] || original && replacements?.[teamSlotKey(original, "ct")] || original && replacements?.[teamSlotKey(original, "t")] || original && replacements?.[slotKey(original)] || null;
    return {
      ...row,
      original_name_zh: row?.original_name_zh || original?.name_zh || "",
      original_name_en: row?.original_name_en || original?.name_en || "",
      replacement_name_zh: row?.replacement_name_zh || row?.name_zh || replacement?.name_zh || "",
      replacement_name_en: row?.replacement_name_en || row?.name_en || replacement?.name_en || ""
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
  return Boolean(onlineAssetsEnabled && !item?.experimental_paint_source_catalog_id && item?.catalog_exact !== false && Number.isInteger(Number(item?.catalog_id)) && ["weapon", "melee"].includes(String(item?.type || "")));
}
function canInspectInGame(item) {
  return Boolean(item?.finish_known !== false && Number.isInteger(Number(item?.def_index)) && Number(item?.def_index) > 0 && Number.isInteger(Number(item?.paint_index ?? 0)) && Number(item?.paint_index ?? 0) >= 0);
}
const viewerUrl = buildCs2ViewerUrl;
function TeamIndicators({
  item,
  compact = false
}) {
  const t = useT();
  const observed = new Set(Array.isArray(item?.observed_teams) ? item.observed_teams : []);
  if (!observed.size) return null;
  return <span className="flex items-center gap-1" aria-label={t("analysis.cosmetics.teamEvidence")}>
      {["ct", "t"].filter(team => observed.has(team)).map(team => <span key={team} title={t(`analysis.cosmetics.observed.${team}`)} className={`${compact ? "h-3 w-3" : "h-4 w-4"} inline-flex items-center justify-center rounded-full border-2 ${team === "ct" ? "border-sky-300 bg-cs2-cyan-surface text-cs2-cyan-on-surface" : "border-amber-300 bg-cs2-amber-surface text-cs2-amber-on-surface"}`}>
          {!compact ? <span className="text-[7px] font-black uppercase leading-none">{team === "ct" ? "C" : "T"}</span> : null}
        </span>)}
    </span>;
}
function CosmeticImage({
  item,
  onlineAssetsEnabled,
  className = ""
}) {
  const [failed, setFailed] = useState(false);
  const base = onlineAssetsEnabled ? String(item?.image_url || "") : "";
  const src = onlineAssetsEnabled && !failed ? imageUrlForWear(base, item?.paint_wear, item) : "";
  useEffect(() => setFailed(false), [item?.image_url, item?.paint_wear, item?.paint_index, item?.is_placeholder, onlineAssetsEnabled]);
  return <>
      {src ? <img key={src} src={src} alt={String(item?.name_zh || item?.name_en || "")} draggable={false} loading="lazy" onError={() => setFailed(true)} className={`object-contain ${className}`} /> : <span className={`flex items-center justify-center text-cs2-text-muted ${className}`}>
          {onlineAssetsEnabled ? <PackageOpen className="h-9 w-9 opacity-55" /> : <WifiOff className="h-8 w-8 opacity-55" />}
        </span>}
    </>;
}
function CraftNameLines({
  item,
  locale,
  rename = "",
  compact = false
}) {
  const parts = craftNameParts(item, locale);
  const rarityColor = String(item?.rarity || "").trim() || "#ded6cc";
  const sizeClass = compact ? "text-[11px]" : "text-xs";
  const baseClass = `break-words font-semibold leading-snug ${sizeClass}`;
  const sep = <span className="text-cs2-text-muted"> | </span>;
  const hasModel = Boolean(parts.model);
  const hasFinish = Boolean(parts.finish);
  const hasAlt = Boolean(parts.alt);
  const fallback = !hasModel && !hasFinish && !hasAlt ? parts.full : "";
  const pipe = hasModel || hasFinish || hasAlt || fallback ? <span className={`block min-w-0 ${baseClass}`}>
      {hasModel ? <span className="text-cs2-text-secondary">{parts.model}</span> : null}
      {hasFinish ? <>
          {hasModel ? sep : null}
          <span style={{
        color: rarityColor
      }}>{parts.finish}</span>
        </> : null}
      {hasAlt ? <>
          {hasModel || hasFinish ? sep : null}
          <span style={{
        color: rarityColor
      }}>{parts.alt}</span>
        </> : null}
      {fallback ? <span style={{
      color: rarityColor
    }}>{fallback}</span> : null}
    </span> : null;
  if (rename) {
    return <>
        <span className="block break-words text-[11px] font-black leading-snug text-cs2-text-primary">“{rename}”</span>
        {pipe ? <span className="mt-0.5 block">{pipe}</span> : null}
      </>;
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
  buttonProps
}) {
  const t = useT();
  const labelSource = labelItem || item;
  const rename = customName(item);
  const name = displayName(labelSource, locale);
  const accessibleName = rename || formatCraftPipeName(labelSource, locale) || name;
  const disabled = customMode && !customizable;
  const showClear = Boolean(customMode && replacement && !replacement.restore && onClearReplacement);
  const replaced = Boolean(replacement && !replacement.restore);
  const rarityColor = String(item?.rarity || "").trim() || "#ded6cc";
  const rarityKey = RARITY_NAMES[rarityColor.toLowerCase()] || "unknown";
  return <button type="button" onClick={() => onOpen?.(item, item)} onPointerEnter={event => onHoverStart?.(event, item)} onPointerLeave={onHoverEnd} onFocus={event => onHoverStart?.(event, item)} onBlur={onHoverEnd} data-cosmetic-card data-replaced={replaced ? "true" : undefined} {...buttonProps} className={`group grid w-full min-w-0 self-start grid-rows-[auto_auto] rounded-[10px] text-left outline-none${disabled ? " cursor-not-allowed opacity-50 grayscale" : ""}`} aria-label={accessibleName}>
      <span className={`cosmetic-preview-surface relative block aspect-[4/3] overflow-hidden rounded-[10px] border transition-colors group-focus-visible:border-cs2-accent ${replaced ? "border-cs2-accent" : "border-cs2-border-subtle group-hover:border-cs2-text-muted"}`}>
        {showClear ? <span role="button" tabIndex={0} data-testid="cosmetics-clear-replacement" aria-label={t("analysis.cosmetics.clearReplacement")} title={t("analysis.cosmetics.clearReplacement")} className="absolute right-1.5 top-1.5 z-[3] inline-flex h-6 w-6 items-center justify-center rounded-md border border-cs2-border bg-cs2-bg-card/95 text-cs2-text-muted shadow-[var(--cs2-shadow-sm)] transition-colors hover:bg-cs2-rose-surface hover:text-cs2-rose-on-surface" onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        onClearReplacement();
      }} onKeyDown={event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onClearReplacement();
      }} onPointerDown={event => event.stopPropagation()}>
            <X className="h-3.5 w-3.5" />
          </span> : null}
        <span data-cosmetic-rarity-rail aria-label={`${t("analysis.cosmetics.rarity")} ${t(`analysis.cosmetics.rarity.${rarityKey}`)}`} title={t(`analysis.cosmetics.rarity.${rarityKey}`)} className="absolute bottom-0 left-0 z-[1] h-[3px] w-full" style={{
        backgroundColor: rarityColor
      }} />
        <CosmeticImage item={item} onlineAssetsEnabled={onlineAssetsEnabled} className="h-full w-full p-2" />
        <CosmeticAttachmentSummary item={item} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} />
        {customMode && customizable ? <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-[2] inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-md border border-cs2-accent bg-cs2-accent px-2.5 py-1 text-[11.5px] font-semibold text-black opacity-0 shadow-[var(--cs2-shadow-md)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <RefreshCw className="h-3 w-3" />
            {t("analysis.cosmetics.swap")}
          </span> : null}
      </span>
      <span data-cosmetic-card-label className="mt-1.5 block min-w-0 overflow-hidden leading-tight">
        <CraftNameLines item={labelSource} locale={locale} rename={rename} compact />
        {item?.experimental_paint_source_catalog_id ? <span className="mt-0.5 block text-[11px] font-semibold text-cs2-accent">{t("cosmeticsWorkshop.experimentalPaint.badge")}</span> : null}
        {replacementLabel ? <span className="mt-0.5 block break-words text-[11px] font-semibold leading-snug text-cs2-accent">{replacementLabel}</span> : null}
      </span>
    </button>;
}
function WorkshopSchemePicker({
  open,
  schemes,
  selectedIndex,
  locale,
  onlineAssetsEnabled,
  onSelect,
  onClose,
  onApply
}) {
  const t = useT();
  const selected = schemes[selectedIndex] || null;
  return <Modal open={open} onClose={onClose} contained title={t("analysis.cosmetics.schemePickerTitle")} subtitle={t("analysis.cosmetics.schemePickerSubtitle")} icon={<Gem className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-5xl" maxHeight="max-h-[86vh]" contentClassName="min-h-0 flex-1 overflow-hidden" footer={<div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" data-testid="cosmetics-confirm-workshop-scheme" disabled={!selected || workshopSchemeSelectionCount(selected) < 1} onClick={onApply}><Check className="h-3.5 w-3.5" />{t("analysis.cosmetics.applySelectedWorkshopScheme")}</Button>
        </div>}>
      <div className="grid h-full min-h-0 grid-cols-[210px_minmax(0,1fr)] overflow-hidden max-[720px]:grid-cols-1">
        <aside className="min-h-0 overflow-y-auto border-r border-cs2-border-subtle bg-cs2-bg-input/35 p-3 max-[720px]:border-b max-[720px]:border-r-0">
          <h3 className="text-[13px] font-semibold text-cs2-text-primary">{t("analysis.cosmetics.availableWorkshopSchemes")}</h3>
          {schemes.length ? <div className="mt-2 space-y-2">{schemes.map((plan, index) => <button key={`${plan.id || "scheme"}-${index}`} type="button" aria-pressed={selectedIndex === index} onClick={() => onSelect(index)} data-active={selectedIndex === index ? "true" : "false"} className="analysis-card analysis-card--interactive w-full p-3 text-left"><span className="block truncate text-[13px] font-semibold text-cs2-text-primary">{plan.name || t("cosmeticsWorkshop.scheme.defaultName")}</span><span className="mt-0.5 block text-[11.5px] text-cs2-text-muted">{t("analysis.cosmetics.workshopSchemeItemCount", {
                count: workshopSchemeSelectionCount(plan)
              })}</span></button>)}</div> : <p className="mt-3 text-xs leading-relaxed text-cs2-text-muted">{t("analysis.cosmetics.workshopSchemeUnavailable")}</p>}
        </aside>

        <section className="min-h-0 overflow-y-auto p-4">
          {selected ? <div>
              <div className="mb-4"><h3 className="text-[15px] font-bold text-cs2-text-primary">{selected.name || t("cosmeticsWorkshop.scheme.defaultName")}</h3><p className="mt-0.5 text-xs text-cs2-text-muted">{t("analysis.cosmetics.workshopSchemePreviewHint")}</p></div>
              <div className="space-y-5">
                {["ct", "t"].map(team => {
              const rows = Object.entries(selected.selections?.[team] || {}).filter(([, item]) => item);
              return <div key={team}><h4 className={`mb-2 inline-flex h-7 items-center rounded-full px-3 text-xs font-semibold ${team === "ct" ? "bg-cs2-cyan-surface text-cs2-cyan-on-surface" : "bg-cs2-amber-surface text-cs2-amber-on-surface"}`}>{t(`analysis.cosmetics.team.${team}`)}</h4>{rows.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{rows.map(([key, item]) => <article key={key} className="analysis-card min-w-0 overflow-hidden"><div className="cosmetic-preview-surface relative aspect-[4/3]"><CosmeticImage item={item} onlineAssetsEnabled={onlineAssetsEnabled} className="h-full w-full p-2" /><CosmeticAttachmentSummary item={item} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} /></div><div className="border-t border-cs2-border-subtle px-2.5 py-2"><CraftNameLines item={item} locale={locale} rename={customName(item)} compact /><div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-cs2-text-muted"><span>{t("analysis.cosmetics.picker.wear")} {Number(item.paint_wear ?? 0).toFixed(6)}</span><span>{t("analysis.cosmetics.picker.seed")} {Math.round(Number(item.paint_seed ?? 0))}</span></div></div></article>)}</div> : <p className="rounded-xl border border-dashed border-cs2-border px-3 py-4 text-xs text-cs2-text-muted">{t("analysis.cosmetics.workshopSchemeTeamEmpty")}</p>}</div>;
            })}
              </div>
            </div> : <div className="flex h-full min-h-[300px] items-center justify-center text-[11px] text-cs2-text-muted">{t("analysis.cosmetics.workshopSchemeUnavailable")}</div>}
        </section>
      </div>
    </Modal>;
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
  loadoutEditor,
  showHeading = true
}) {
  const t = useT();
  const teamKey = team === "ct" ? "ct" : "t";
  return <section data-testid={`cosmetics-row-${teamKey}`} className="space-y-2">
      {showHeading ? <div className="flex items-center gap-2.5">
          <div data-testid={`cosmetics-row-heading-${teamKey}`} className={`inline-flex h-7 items-center rounded-full px-3 ${teamKey === "ct" ? "bg-cs2-cyan-surface text-cs2-cyan-on-surface" : "bg-cs2-amber-surface text-cs2-amber-on-surface"}`}>
            <h3 className="text-xs font-semibold">{t(`analysis.cosmetics.team.${teamKey}`)}</h3>
          </div>
          <span className="h-px flex-1 bg-cs2-border-subtle" aria-hidden />
        </div> : null}
      {items.length || loadoutEditor ? <div className="grid grid-cols-2 items-start gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {sortCosmeticsForRow(items, locale, item => {
        const key = teamSlotKey(item, teamKey);
        const replacement = localReplacements?.[key];
        const snapshot = originalBySlot?.[key];
        const originalItem = restoreOriginalVisual(item, snapshot);
        return replacement ? cosmeticPreview(originalItem, replacement) : originalItem;
      }).map((item, index) => {
        const key = teamSlotKey(item, teamKey);
        const replacement = localReplacements?.[key] || null;
        const snapshot = originalBySlot?.[key] || null;
        const originalItem = restoreOriginalVisual(item, snapshot);
        const modified = Boolean(replacement && !replacement.restore);
        const visualItem = modified ? {
          ...cosmeticPreview(originalItem, replacement),
          demo_original: originalItem
        } : originalItem;
        const labelItem = snapshot ? originalItem : item;
        return <CosmeticCard key={`${teamKey}-${item?.item_id || item?.catalog_id || "item"}-${index}`} item={visualItem} labelItem={labelItem} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} customMode={customMode} customizable={isCustomizable(item)} replacement={replacement} replacementLabel={replacement && !replacement.restore ? t("analysis.cosmetics.replacementPreview", {
          name: formatCraftPipeName(replacement, locale) || displayName(replacement, locale)
        }) : null} onOpen={() => onOpen?.(item, visualItem, teamKey)} onHoverStart={event => onHoverStart?.(event, visualItem)} onHoverEnd={onHoverEnd} onClearReplacement={replacement && !replacement.restore && onClearReplacement ? () => onClearReplacement(key) : null} />;
      })}
          {loadoutEditor}
        </div> : null}
    </section>;
}
function WearBar({
  wear,
  wearMin,
  wearMax,
  compact = false
}) {
  const value = Number(wear);
  if (!Number.isFinite(value)) return null;
  const position = Math.max(0, Math.min(100, value * 100));
  const min = finiteNumber(wearMin);
  const max = finiteNumber(wearMax);
  const bounded = min !== null && max !== null && (min > 0 || max < 1);
  return <div className={compact ? "mt-2" : "mt-3"}>
      <div className={`${compact ? "h-1" : "h-1.5"} relative overflow-visible bg-[linear-gradient(90deg,#3b818f_0%,#3b818f_7%,#83b135_7%,#83b135_15%,#d7be47_15%,#d7be47_38%,#f08140_38%,#f08140_45%,#ec4f3d_45%,#ec4f3d_100%)]`}>
        {bounded ? <>
            <span className="absolute inset-y-0 left-0 bg-black/55" style={{
          width: `${Math.max(0, min) * 100}%`
        }} />
            <span className="absolute inset-y-0 right-0 bg-black/55" style={{
          width: `${Math.max(0, 1 - max) * 100}%`
        }} />
          </> : null}
        <span className="absolute -top-1 h-3.5 w-0.5 bg-cs2-text-primary shadow" style={{
        left: `calc(${position}% - 1px)`
      }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10.5px] text-cs2-text-muted"><span>{bounded ? min.toFixed(2) : "0.00"}</span><span className="font-bold text-cs2-text-secondary">{value.toFixed(6)}</span><span>{bounded ? max.toFixed(2) : "1.00"}</span></div>
    </div>;
}
function HoverDetails({
  item,
  locale,
  position
}) {
  const t = useT();
  const wear = finiteNumber(item?.paint_wear);
  const seed = finiteNumber(item?.paint_seed);
  const assetId = item?.item_id;
  const finishKnown = item?.finish_known !== false;
  return <div role="tooltip" data-cosmetic-hover-card className="pointer-events-none fixed z-[120] w-72 rounded-[10px] border border-cs2-border bg-cs2-bg-card/[0.98] p-3 shadow-[var(--cs2-shadow-lg)] backdrop-blur" style={{
    left: position.x,
    top: position.y
  }}>
      <div className="flex items-start justify-between gap-3 border-b border-cs2-border pb-2">
        <div className="min-w-0">
          {customName(item) ? <p className="truncate text-[12px] font-black text-cs2-text-primary">“{customName(item)}”</p> : null}
          <div className={customName(item) ? "mt-0.5" : ""}>
            <CraftNameLines item={item} locale={locale} />
          </div>
        </div>
        <TeamIndicators item={item} compact />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <span className="text-cs2-text-muted">{t("analysis.cosmetics.type")}</span>
        <span className="text-right font-semibold text-cs2-text-secondary">{t(`analysis.cosmetics.type.${item?.type || "unknown"}`)}</span>
        {finishKnown && Number(item?.paint_index) > 0 ? <><span className="text-cs2-text-muted">{t("analysis.cosmetics.paintIndex")}</span><span className="text-right font-mono font-semibold text-cs2-text-secondary">{Number(item.paint_index)}</span></> : null}
        {seed !== null ? <><span className="text-cs2-text-muted">{t("analysis.cosmetics.seed")}</span><span className="text-right font-mono font-semibold text-cs2-text-secondary">{Math.trunc(seed)}</span></> : null}
        {assetId ? <><span className="text-cs2-text-muted">{t("analysis.cosmetics.assetId")}</span><span className="truncate text-right font-mono font-semibold text-cs2-text-secondary">{assetId}</span></> : null}
      </div>
      {!finishKnown ? <div className="mt-2 rounded-md bg-cs2-amber-surface px-2 py-1.5 text-[11px] leading-relaxed text-cs2-amber-on-surface">{t("analysis.cosmetics.finishUnavailable")}</div> : null}
      {wear !== null ? <div className="mt-2 border-t border-cs2-border pt-2">
          <div className="flex items-center justify-between text-[11px]"><span className="text-cs2-text-muted">{t("analysis.cosmetics.exterior")}</span><span className="font-semibold text-cs2-text-secondary">{t(`analysis.cosmetics.exterior.${exteriorKey(wear)}`)}</span></div>
          <WearBar wear={wear} wearMin={item?.wear_min} wearMax={item?.wear_max} compact />
        </div> : null}
    </div>;
}
function DetailRow({
  label,
  children
}) {
  if (children === undefined || children === null || children === "") return null;
  return <div className="grid grid-cols-[108px_minmax(0,1fr)] gap-3 border-b border-cs2-border-subtle py-2 text-[11px] last:border-b-0">
      <dt className="text-cs2-text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-semibold text-cs2-text-secondary">{children}</dd>
    </div>;
}
function ItemDetail({
  item,
  locale,
  onlineAssetsEnabled,
  onOpen3d,
  onInspectInGame,
  onCopy,
  onOriginal,
  inspectBusy,
  inspectFeedback
}) {
  const t = useT();
  const inspectLink = cosmeticInspectLink(item);
  const stickers = Array.isArray(item?.stickers) ? item.stickers : [];
  const supportsStickers = String(item?.type || "") === "weapon";
  const observed = Array.isArray(item?.observed_teams) ? item.observed_teams : [];
  const compatible = eligibleTeams(item);
  const description = localized(item, "desc", locale);
  const collection = localized(item, "collection_name", locale);
  const rarityKey = RARITY_NAMES[String(item?.rarity || "").toLowerCase()] || "unknown";
  const wear = finiteNumber(item?.paint_wear);
  const seed = finiteNumber(item?.paint_seed);
  const finishKnown = item?.finish_known !== false;
  return <div className="grid min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
      <div data-cosmetic-detail-preview className="flex flex-col items-center justify-center gap-4 border-b border-cs2-border bg-cs2-bg-page/30 p-5 lg:border-b-0 lg:border-r">
        {onlineAssetsEnabled && collection && item?.collection_image_url ? <div className="flex items-center gap-2 self-start text-[11px] text-cs2-text-secondary">
            <img src={item.collection_image_url} alt="" className="h-8 w-8 object-contain" />
            <span>{collection}</span>
          </div> : null}
        <CosmeticImage item={item} onlineAssetsEnabled={onlineAssetsEnabled} className="max-h-[300px] w-full" />
        {supportsStickers && stickers.length && onlineAssetsEnabled ? <div className="flex w-full flex-wrap justify-center gap-4">
            {stickers.map((sticker, index) => <div key={`${sticker?.catalog_id || "sticker"}-${index}`} className="w-[5.5rem] text-center">
                <img src={sticker?.image_url} alt="" className="mx-auto h-20 w-20 object-contain" />
                <span className="mt-1.5 block break-words text-[11px] leading-snug text-cs2-text-muted">
                  {localized(sticker, "name", locale)}
                </span>
              </div>)}
          </div> : supportsStickers && stickers.length ? <div className="inline-flex items-center gap-1.5 text-xs text-cs2-text-muted"><WifiOff className="h-3.5 w-3.5" />{t("analysis.cosmetics.onlineAssetsOff")}</div> : supportsStickers ? <div className="inline-flex items-center gap-1.5 text-xs text-cs2-text-muted"><Sticker className="h-3.5 w-3.5" />{t("analysis.cosmetics.noStickerEvidence")}</div> : null}
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
            <div className="flex shrink-0 items-center gap-2">
              <span data-cosmetic-detail-rarity-label className="text-xs font-semibold leading-5" style={{
              color: item?.rarity || "#ded6cc"
            }}>
                {t(`analysis.cosmetics.rarity.${rarityKey}`)}
              </span>
              <TeamIndicators item={item} />
            </div>
          </div>
        </div>
        <dl>
          <DetailRow label={t("analysis.cosmetics.type")}>{t(`analysis.cosmetics.type.${item?.type || "unknown"}`)}</DetailRow>
          <DetailRow label={t("analysis.cosmetics.rarity")}><span style={{
            color: item?.rarity
          }}>{t(`analysis.cosmetics.rarity.${rarityKey}`)}</span></DetailRow>
          {wear !== null ? <DetailRow label={t("analysis.cosmetics.exterior")}>{t(`analysis.cosmetics.exterior.${exteriorKey(wear)}`)}</DetailRow> : null}
          <DetailRow label={t("analysis.cosmetics.observedTeams")}>{observed.length ? observed.map(team => team.toUpperCase()).join(" + ") : t("analysis.cosmetics.notObserved")}</DetailRow>
          <DetailRow label={t("analysis.cosmetics.compatibleTeams")}>{compatible.length ? compatible.map(team => team.toUpperCase()).join(" + ") : t("analysis.cosmetics.notApplicable")}</DetailRow>
          <DetailRow label={t("analysis.cosmetics.definitionIndex")}>{Number(item?.def_index)}</DetailRow>
          {finishKnown && Number(item?.paint_index) > 0 ? <DetailRow label={t("analysis.cosmetics.paintIndex")}>{Number(item.paint_index)}</DetailRow> : null}
          {seed !== null ? <DetailRow label={t("analysis.cosmetics.seed")}>{Math.trunc(seed)}</DetailRow> : null}
          <DetailRow label={t("analysis.cosmetics.assetId")}><span className="font-mono">{item?.item_id}</span></DetailRow>
        </dl>
        {!finishKnown ? <div className="mt-3 rounded-lg bg-cs2-amber-surface px-3 py-2 text-xs leading-relaxed text-cs2-amber-on-surface">{t("analysis.cosmetics.finishUnavailable")}</div> : null}
        <WearBar wear={wear} wearMin={item?.wear_min} wearMax={item?.wear_max} />
        {description ? <p className="mt-4 whitespace-pre-line border-t border-cs2-border pt-4 text-[11px] leading-relaxed text-cs2-text-secondary">{description}</p> : null}
        {inspectFeedback ? <div role={inspectFeedback.tone === "error" ? "alert" : "status"} className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${inspectFeedback.tone === "error" ? "bg-cs2-rose-surface text-cs2-rose-on-surface" : "bg-cs2-emerald-surface text-cs2-emerald-on-surface"}`}>
            <Info className="h-3.5 w-3.5 shrink-0" />
            {inspectFeedback.text}
          </div> : null}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button data-cosmetic-open-3d variant="secondary" disabled={!canInspect3d(item, onlineAssetsEnabled)} onClick={onOpen3d}><Rotate3D className="h-4 w-4" />{t("analysis.cosmetics.inspect3d")}</Button>
          <Button variant="secondary" disabled={!canInspectInGame(item) || inspectBusy} onClick={onInspectInGame} aria-live="polite">
            {inspectBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gamepad2 className="h-4 w-4" />}
            {t("analysis.cosmetics.inspectInGame")}
          </Button>
          {null}
        </div>
        {item?.demo_original ? <Button variant="ghost" size="sm" className="mt-2" onClick={() => onOriginal?.(item.demo_original)}>
            {t("analysis.cosmetics.viewDemoOriginal")}
          </Button> : null}
      </div>
    </div>;
}
export default function CosmeticsView({
  workspace,
  selectedPlayer,
  locale = "zh",
  onlineAssetsEnabled = false,
  demoId = null,
  avatarUrl = ""
}) {
  const t = useT();
  const name = playerName(selectedPlayer);
  const selectedPlayerKey = playerIdentityKey(selectedPlayer);
  const workspacePlayer = useMemo(() => {
    const byIdentity = (workspace?.players || []).find(player => playerIdentityKey(player) === selectedPlayerKey);
    if (byIdentity) return byIdentity;
    const target = name.toLocaleLowerCase();
    return (workspace?.players || []).find(player => playerName(player).toLocaleLowerCase() === target) || null;
  }, [name, selectedPlayerKey, workspace?.players]);
  const steamid = steamIdForPlayer(workspacePlayer) || steamIdForPlayer(selectedPlayer);
  const [detail, setDetail] = useState(null);
  const [pickerInspectItem, setPickerInspectItem] = useState(null);
  const [hoverCard, setHoverCard] = useState(null);
  const [notice, setNotice] = useState(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectFeedback, setInspectFeedback] = useState(null);
  const [viewMode, setViewMode] = useState("browse");
  const [localReplacements, setLocalReplacements] = useState({});
  const [savedReplacements, setSavedReplacements] = useState({});
  const [playerLoadout, setPlayerLoadout] = useState({});
  const [savedLoadout, setSavedLoadout] = useState({});
  const [originalBySlot, setOriginalBySlot] = useState({});
  const [savedOriginals, setSavedOriginals] = useState({});
  const [pickerItem, setPickerItem] = useState(null);
  const [pickerTeam, setPickerTeam] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [schemePickerOpen, setSchemePickerOpen] = useState(false);
  const [workshopSchemes, setWorkshopSchemes] = useState([]);
  const [selectedWorkshopSchemeIndex, setSelectedWorkshopSchemeIndex] = useState(0);
  const [workshopScheme, setWorkshopScheme] = useState(null);
  const planScope = `${String(demoId ?? "")}:${String(steamid || "")}`;
  const planScopeRef = useRef(planScope);
  planScopeRef.current = planScope;
  const inventory = useMemo(() => {
    const rows = workspace?.cosmetics?.players?.[steamid];
    return Array.isArray(rows) ? rows.filter(isVisibleCosmeticEvidence) : [];
  }, [steamid, workspace?.cosmetics?.players]);
  const loadoutInventory = useMemo(() => {
    const rows = workspace?.cosmetics?.players?.[steamid];
    return Array.isArray(rows) ? rows.filter(item => ["agent", "musickit"].includes(item?.type)) : [];
  }, [steamid, workspace?.cosmetics?.players]);
  const ctItems = useMemo(() => mergeLoadoutWithEvidence(listDefaultLoadout("ct"), itemsForTeam(inventory, "ct"), locale), [inventory, locale]);
  const tItems = useMemo(() => mergeLoadoutWithEvidence(listDefaultLoadout("t"), itemsForTeam(inventory, "t"), locale), [inventory, locale]);
  const browseMode = viewMode === "browse";
  const hasReplacements = Object.keys(localReplacements).length > 0;
  const loadoutChanged = JSON.stringify(playerLoadout) !== JSON.stringify(savedLoadout);
  const canSavePlan = Boolean(demoId) && (hasReplacements || loadoutChanged) && !saving;
  const rewriteOperations = useMemo(() => {
    const zh = String(locale).startsWith("zh");
    const labels = {
      agent_t: zh ? "T 探员" : "T agent",
      agent_ct: zh ? "CT 探员" : "CT agent",
      music_kit: zh ? "音乐盒" : "Music kit"
    };
    const loadoutRows = Object.keys(labels).filter(key => playerLoadout[key] !== savedLoadout[key]).map(key => {
      const describe = value => {
        const item = loadoutCandidates(key, true).find(row => (key === "music_kit" ? row.index : row.def) === value);
        return (zh ? item?.nameZh : item?.nameEn) || (zh ? "Demo 原设置" : "Original demo setting");
      };
      return {
        key: `loadout:${key}`,
        from: `${labels[key]} · ${describe(savedLoadout[key])}`,
        to: describe(playerLoadout[key])
      };
    });
    return [...rewriteOperationRows(localReplacements, originalBySlot, inventory, locale), ...loadoutRows];
  }, [inventory, localReplacements, locale, originalBySlot, playerLoadout, savedLoadout]);
  const clearOverlays = () => {
    setDetail(null);
    setPickerInspectItem(null);
    setHoverCard(null);
    setPickerItem(null);
    setPickerTeam(null);
    setSchemePickerOpen(false);
  };
  useEffect(() => {
    setDetail(null);
    setHoverCard(null);
    setNotice(null);
    setInspectFeedback(null);
    setViewMode("browse");
    setLocalReplacements({});
    setSavedReplacements({});
    setPlayerLoadout({});
    setSavedLoadout({});
    setOriginalBySlot({});
    setSavedOriginals({});
    setPickerItem(null);
    setPickerTeam(null);
    setSaving(false);
    setSaveResult(null);
    setSchemePickerOpen(false);
    setWorkshopSchemes([]);
    setSelectedWorkshopSchemeIndex(0);
    setWorkshopScheme(null);
  }, [demoId, steamid]);
  useEffect(() => {
    if (inspectFeedback?.tone !== "success") return undefined;
    const timeout = window.setTimeout(() => setInspectFeedback(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [inspectFeedback]);
  useEffect(() => {
    if (!demoId || !steamid) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await loadCustomSkinPlan({
          demoId,
          steamid
        });
        if (cancelled) return;
        const seeded = replacementsFromPlan(data?.plan, inventory);
        const originals = originalsFromPlan(data?.plan, inventory);
        setSavedReplacements(seeded || {});
        setPlayerLoadout(data?.plan?.player_loadout || {});
        setSavedLoadout(data?.plan?.player_loadout || {});
        setLocalReplacements(seeded || {});
        setSavedOriginals(originals);
        setOriginalBySlot(originals);
        if (data?.plan && data.applied === false) {
          setSavedReplacements({});
          setSavedLoadout({});
          setNotice({
            tone: "info",
            text: t("analysis.cosmetics.planNeedsReapply")
          });
        }
      } catch {
        // Keep empty local state when load fails; user can still customize.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demoId, inventory, steamid]);
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
    const y = below + estimatedHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - estimatedHeight - 8);
    setHoverCard({
      item,
      position: {
        x,
        y
      }
    });
  };
  const writeClipboard = async text => {
    let clipboardError = null;
    if (desktopBridge?.writeClipboardText) {
      try {
        await desktopBridge.writeClipboardText(text);
        return;
      } catch (error) {
        clipboardError = error;
      }
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        clipboardError = error;
        // Browser clipboard permissions vary. Keep the synchronous DOM copy
        // path below for ordinary web previews and older WebViews.
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand?.("copy");
    textarea.remove();
    if (!copied) throw clipboardError || new Error("Clipboard API unavailable");
  };
  const inspectInGame = async item => {
    setInspectBusy(true);
    setInspectFeedback(null);
    try {
      const result = await launchCs2Inspect(item, {
        launchInspect: launchCs2InspectOnHost,
        openExternal: desktopBridge?.openExternal,
        writeClipboardText: writeClipboard
      });
      const messageKey = result.status === "launched" ? "analysis.cosmetics.inspectLaunched" : "analysis.cosmetics.inspectCommandCopied";
      setInspectFeedback({
        tone: "success",
        text: t(messageKey)
      });
    } catch (error) {
      console.warn("Failed to launch CS2 inspect", error);
      setInspectFeedback({
        tone: "error",
        text: t("analysis.cosmetics.inspectFailed")
      });
    } finally {
      setInspectBusy(false);
    }
  };
  const openItemDetail = item => {
    if (!browseMode) return;
    setHoverCard(null);
    setInspectFeedback(null);
    setDetail({
      item,
      mode: "info"
    });
  };
  const openCard = (item, previewItem, team) => {
    if (browseMode) {
      openItemDetail(previewItem || item);
      return;
    }
    if (isCustomizable(item)) {
      setInspectFeedback(null);
      setPickerItem(item);
      setPickerTeam(team);
    }
  };
  const pickerPreview = useMemo(() => {
    if (!pickerItem) return null;
    const key = teamSlotKey(pickerItem, pickerTeam);
    const original = restoreOriginalVisual(pickerItem, originalBySlot[key]);
    return localReplacements[key] ? cosmeticPreview(original, localReplacements[key]) : original;
  }, [pickerItem, pickerTeam, originalBySlot, localReplacements]);
  const cancelCustomize = () => {
    setPlayerLoadout({
      ...savedLoadout
    });
    setLocalReplacements({
      ...savedReplacements
    });
    setOriginalBySlot({
      ...savedOriginals
    });
    clearOverlays();
    setViewMode("browse");
  };
  const confirmReplacement = replacement => {
    if (!pickerItem) return;
    const key = teamSlotKey(pickerItem, pickerTeam);
    setOriginalBySlot(prev => {
      if (prev[key]) return prev;
      // Row map may already show the preview skin; prefer the live inventory row.
      const baseKey = slotKey(pickerItem);
      const evidence = inventory.find(row => slotKey(row) === baseKey) || pickerItem;
      const pending = localReplacements[key];
      if (pending && !pending.restore) {
        const paintMatches = Number(evidence?.paint_index) === Number(pending.paint_index) && Number(evidence?.def_index) === Number(pending.def_index);
        // Inventory already equals the customized skin — do not treat it as the demo original.
        if (paintMatches) return prev;
      }
      return {
        ...prev,
        [key]: snapshotOriginalItem(evidence, pickerTeam)
      };
    });
    setLocalReplacements(prev => ({
      ...prev,
      [key]: replacement
    }));
    setPickerItem(null);
    setPickerTeam(null);
  };
  const clearReplacement = key => {
    const slot = String(key || "").trim();
    if (!slot) return;
    const snapshot = originalBySlot[slot];
    const restore = restoreReplacementFromSnapshot(snapshot);
    if (!restore) {
      // No snapshot — drop the pending replacement only.
      setLocalReplacements(prev => {
        if (!(slot in prev)) return prev;
        const next = {
          ...prev
        };
        delete next[slot];
        return next;
      });
      return;
    }
    // Keep the slot in replacements so save posts the original skin back to skin-core.
    setLocalReplacements(prev => ({
      ...prev,
      [slot]: restore
    }));
  };
  const savePlan = async (overrides = null) => {
    const replacementsToSave = overrides?.replacements || localReplacements;
    const originalsToSave = overrides?.originals || originalBySlot;
    if (!demoId || !Object.keys(replacementsToSave).length && !loadoutChanged || saving) return;
    const requestedScope = planScope;
    setSaving(true);
    setNotice({
      tone: "info",
      text: t("analysis.cosmetics.savingPlan")
    });
    try {
      const result = await saveCustomSkinPlan({
        demoId,
        steamid,
        replacements: replacementsForApi(replacementsToSave),
        originals: originalsToSave,
        ...(loadoutChanged ? {
          playerLoadout
        } : {})
      });
      // A batch demo can be switched while the rewrite request is in flight.
      // Never apply demo A's late result to the reused view for demo B.
      if (planScopeRef.current !== requestedScope) return;
      const succeeded = enrichSaveResultRows(Array.isArray(result?.succeeded) ? result.succeeded : [], inventory, replacementsToSave);
      if (result?.ok && loadoutChanged) {
        succeeded.push(...rewriteOperations.filter(row => row.key.startsWith("loadout:")).map(row => ({
          slot_key: row.key,
          original_name_zh: row.from,
          original_name_en: row.from,
          replacement_name_zh: row.to,
          replacement_name_en: row.to
        })));
      }
      const failed = enrichSaveResultRows(Array.isArray(result?.failed) ? result.failed : [], inventory, replacementsToSave);
      const hasItemResults = succeeded.length > 0 || failed.length > 0;
      const failureMessage = result?.ok ? null : saveFailureMessage(result, t);
      if (hasItemResults) {
        setSaveResult({
          ok: Boolean(result?.ok),
          partial: Boolean(result?.partial) || succeeded.length > 0 && failed.length > 0,
          succeeded,
          failed,
          error: failureMessage
        });
      }
      if (result?.ok) {
        const seeded = replacementsFromPlan(result?.plan, inventory) || {};
        const fromPlan = originalsFromPlan(result?.plan, inventory);
        // Prefer in-session first-seen originals over plan rows (inventory may already be the new skin).
        const originals = mergeOriginalsPreferExisting(fromPlan, originalsToSave);
        setSavedReplacements(seeded);
        setPlayerLoadout(result?.plan?.player_loadout || {});
        setSavedLoadout(result?.plan?.player_loadout || {});
        setSavedOriginals(originals);
        if (failed.length > 0) {
          // Keep succeeded overlays from the saved plan; only retain failed slots as
          // pending so the grid refreshes immediately (switching players used to be
          // required because we dropped succeeded keys from localReplacements).
          const failedKeys = new Set(failed.map(row => row?.slot_key).filter(Boolean));
          setLocalReplacements(() => ({
            ...seeded,
            ...Object.fromEntries(Object.entries(replacementsToSave).filter(([key]) => failedKeys.has(key)))
          }));
          setOriginalBySlot(() => ({
            ...originals,
            ...Object.fromEntries(Object.entries(originalsToSave).filter(([key]) => failedKeys.has(key)))
          }));
          setNotice({
            tone: "info",
            text: t("analysis.cosmetics.savePartial")
          });
        } else {
          setLocalReplacements(seeded);
          setOriginalBySlot(originals);
          setNotice({
            tone: "success",
            text: t("analysis.cosmetics.saveSuccess")
          });
          clearOverlays();
          setViewMode("browse");
        }
      } else {
        setNotice({
          tone: "error",
          text: failureMessage
        });
      }
    } catch (error) {
      if (planScopeRef.current !== requestedScope) return;
      setNotice({
        tone: "error",
        text: error?.message || t("analysis.cosmetics.saveFailed")
      });
    } finally {
      if (planScopeRef.current === requestedScope) setSaving(false);
    }
  };
  const applyWorkshopScheme = () => {
    const plan = workshopScheme;
    if (!plan) {
      setNotice({
        tone: "error",
        text: t("analysis.cosmetics.workshopSchemeUnavailable")
      });
      return;
    }
    const draft = workshopSchemeDraft(plan, {
      ct: ctItems,
      t: tItems
    }, originalBySlot);
    if (!Object.keys(draft.replacements).length) {
      setNotice({
        tone: "error",
        text: t("analysis.cosmetics.workshopSchemeNoMatch")
      });
      return;
    }
    clearOverlays();
    setSchemePickerOpen(false);
    setLocalReplacements(draft.replacements);
    setOriginalBySlot(draft.originals);
    void savePlan(draft);
  };
  const open3d = item => {
    setHoverCard(null);
    setDetail({
      item,
      mode: "3d"
    });
  };
  const copyInspectUrl = async link => {
    try {
      await writeClipboard(link);
      setInspectFeedback({
        tone: "success",
        text: t("analysis.cosmetics.inspectUrlCopied")
      });
    } catch (error) {
      setInspectFeedback({
        tone: "error",
        text: error.message
      });
    }
  };
  if (!selectedPlayer || !steamid) {
    return <EmptyState icon={Gem} title={t("analysis.cosmetics.pickPlayer")} hint={t("analysis.cosmetics.pickPlayerHint")} className="min-h-[360px]" />;
  }
  return <>
    <div data-testid="cosmetics-view" className="min-h-full">
      <div className="mb-3 space-y-3">
        <FocusedPlayerHeader player={selectedPlayer} avatarUrl={avatarUrl} fallbackTone={Number(selectedPlayer?.team ?? selectedPlayer?.team_number) === 3 ? "amber" : "blue"} name={name} caption={browseMode ? t("analysis.cosmetics.caption") : t("analysis.cosmetics.captionCustomizing")} captionColor="var(--cs2-accent)" actions={browseMode ? <AccentButton data-testid="cosmetics-customize" onClick={() => {
          clearOverlays();
          const schemes = readWorkshopSchemes();
          setWorkshopSchemes(schemes);
          setSelectedWorkshopSchemeIndex(0);
          setWorkshopScheme(schemes[0] || null);
          setViewMode("custom");
        }}>
              <Gem data-testid="cosmetics-customize-icon" className="h-3.5 w-3.5 text-cs2-accent" aria-hidden />
              {t("analysis.cosmetics.customize")}
            </AccentButton> : <>
              <AccentButton data-testid="cosmetics-apply-workshop-scheme" disabled={!demoId || saving} title={t("analysis.cosmetics.selectWorkshopScheme")} onClick={() => {
            const schemes = readWorkshopSchemes();
            setWorkshopSchemes(schemes);
            setSelectedWorkshopSchemeIndex(0);
            setWorkshopScheme(schemes[0] || null);
            setSchemePickerOpen(true);
          }}>
                <Gem className="h-3.5 w-3.5" aria-hidden />
                {t("analysis.cosmetics.selectWorkshopScheme")}
              </AccentButton>
              <AccentButton variant="neutral" disabled={saving} onClick={cancelCustomize}>
                <X data-testid="cosmetics-cancel-icon" className="h-3.5 w-3.5 text-cs2-text-muted" aria-hidden />
                {t("analysis.cosmetics.cancelCustomize")}
              </AccentButton>
              <AccentButton variant="solid" data-testid="cosmetics-save-plan" disabled={!canSavePlan} aria-busy={saving} onClick={() => void savePlan()}>
                {saving ? <Loader2 data-testid="cosmetics-save-plan-icon" className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check data-testid="cosmetics-save-plan-icon" className="h-3.5 w-3.5" aria-hidden />}
                {saving ? t("analysis.cosmetics.savingPlan") : t("analysis.cosmetics.savePlan")}
              </AccentButton>
            </>} />

        {browseMode ? <TipStrip icon={Info} testId="cosmetics-tip">
            {t("analysis.cosmetics.interactionHint")}
            <span className="text-cs2-text-muted">· {t("analysis.cosmetics.ownershipHint")}</span>
          </TipStrip> : <TipStrip icon={MousePointerClick} testId="cosmetics-tip">
            {saving ? t("analysis.cosmetics.savingPlan") : !demoId ? t("analysis.cosmetics.saveNeedsDemo") : t("analysis.cosmetics.customizingHint")}
          </TipStrip>}

        {notice ? <div className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${notice.tone === "error" ? "bg-cs2-rose-surface text-cs2-rose-on-surface" : notice.tone === "info" ? "bg-cs2-cyan-surface text-cs2-cyan-on-surface" : "bg-cs2-emerald-surface text-cs2-emerald-on-surface"}`}>
            {notice.tone === "error" ? <Info className="h-3.5 w-3.5 shrink-0" /> : notice.tone === "info" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Check className="h-3.5 w-3.5 shrink-0" />}
            {notice.text}
          </div> : null}

        {!onlineAssetsEnabled ? <div className="flex items-center gap-2 rounded-lg bg-cs2-bg-input/60 px-3 py-2 text-xs text-cs2-text-muted"><WifiOff className="h-3.5 w-3.5 shrink-0" />{t("analysis.cosmetics.onlineAssetsOff")}</div> : null}
      </div>

      <PlayerLoadoutEditor key={planScope} value={playerLoadout} onChange={setPlayerLoadout} editable={!browseMode && !saving} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} /><div className="space-y-[18px]" data-testid="cosmetics-team-stack">
        {[["ct", ctItems], ["t", tItems]].map(([team, items]) => <CosmeticsTeamRow key={team} team={team} items={items} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} customMode={!browseMode} localReplacements={localReplacements} originalBySlot={originalBySlot} onOpen={openCard} onHoverStart={openHover} onHoverEnd={() => setHoverCard(null)} onClearReplacement={browseMode ? null : clearReplacement} />)}
      </div>

      {hoverCard ? <HoverDetails item={hoverCard.item} locale={locale} position={hoverCard.position} /> : null}

      <Modal open={Boolean(detail) && !false} onClose={() => {
        setDetail(null);
        setInspectFeedback(null);
      }} contained title={detail ? customName(detail.item) || displayName(detail.item, locale) : ""} subtitle={detail?.mode === "3d" ? t("analysis.cosmetics.inspect3d") : localized(detail?.item, "collection_name", locale) || t("analysis.cosmetics.itemInfo")} icon={detail?.mode === "3d" ? <Rotate3D className="h-4 w-4 text-cs2-accent" /> : <Gem className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-6xl" maxHeight="max-h-[90vh]" className={detail?.mode === "3d" ? "" : "!h-auto"} contentClassName={detail?.mode === "3d" ? "flex-1 overflow-y-auto" : "overflow-y-auto"} headerRight={detail?.mode === "3d" ? <button type="button" onClick={() => setDetail({
        item: detail.item,
        mode: "info"
      })} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"><ChevronLeft className="h-3.5 w-3.5" />{t("analysis.cosmetics.backToInfo")}</button> : null}>
        {detail?.mode === "3d" ? <div data-cosmetic-inspect-stage className="bg-[radial-gradient(circle_at_50%_42%,rgba(255,117,24,0.10),transparent_38%),linear-gradient(180deg,#101419_0%,#080a0d_100%)]">
            {null}
            <iframe title={t("analysis.cosmetics.inspect3d")} src={viewerUrl(detail.item)} className="h-[72vh] w-full border-0 bg-transparent" allow="fullscreen" />
          </div> : detail ? <ItemDetail item={detail.item} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} onOpen3d={() => open3d(detail.item)} onInspectInGame={() => void inspectInGame(detail.item)} onCopy={link => void copyInspectUrl(link)} onOriginal={item => setDetail({
          item,
          mode: "info"
        })} inspectBusy={inspectBusy} inspectFeedback={inspectFeedback} /> : null}
      </Modal>

      {null}

      <SkinReplacementPicker open={Boolean(pickerItem)} sourceItem={pickerPreview} originalItem={pickerItem ? restoreOriginalVisual(pickerItem, originalBySlot[teamSlotKey(pickerItem, pickerTeam)]) : null} initialReplacement={pickerItem ? localReplacements[teamSlotKey(pickerItem, pickerTeam)] : null} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} inspectBusy={inspectBusy} inspectFeedback={inspectFeedback} onClose={() => {
        setPickerItem(null);
        setPickerTeam(null);
        setInspectFeedback(null);
      }} onConfirm={confirmReplacement} onInspectInGame={item => void inspectInGame(item)} onInspect3d={item => setPickerInspectItem(item)} />

      <Modal open={Boolean(pickerInspectItem)} onClose={() => setPickerInspectItem(null)} title={t("analysis.cosmetics.inspect3d")} subtitle={pickerInspectItem ? displayName(pickerInspectItem, locale) : ""} icon={<Rotate3D className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-[920px]" maxHeight="max-h-[88vh]" contentClassName="overflow-hidden" zIndex={140}>
        {pickerInspectItem ? <div className="bg-[radial-gradient(circle_at_50%_42%,rgba(255,117,24,0.10),transparent_38%),linear-gradient(180deg,#101419_0%,#080a0d_100%)]">
            {null}
            <iframe title={t("analysis.cosmetics.inspect3d")} src={viewerUrl(pickerInspectItem)} className="h-[68vh] w-full border-0 bg-transparent" allow="fullscreen" />
          </div> : null}
      </Modal>

      <WorkshopSchemePicker open={schemePickerOpen} schemes={workshopSchemes} selectedIndex={selectedWorkshopSchemeIndex} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} onSelect={index => {
        setSelectedWorkshopSchemeIndex(index);
        setWorkshopScheme(workshopSchemes[index] || null);
      }} onClose={() => setSchemePickerOpen(false)} onApply={applyWorkshopScheme} />

      <Modal open={Boolean(saveResult)} onClose={() => setSaveResult(null)} title={t("analysis.cosmetics.saveResultTitle")} icon={<Gem className="h-4 w-4 text-cs2-accent" />} maxWidth="max-w-md" maxHeight="max-h-[70vh]" className="!h-auto" contentClassName="overflow-y-auto" footer={<div className="flex justify-end">
            <Button variant="secondary" size="sm" data-testid="cosmetics-save-result-close" onClick={() => setSaveResult(null)}>
              {t("analysis.cosmetics.saveResultClose")}
            </Button>
          </div>}>
        {saveResult ? <div className="space-y-4 px-5 py-4" data-testid="cosmetics-save-result">
            {saveResult.error ? <p className="rounded-lg bg-cs2-rose-surface px-3 py-2 text-xs leading-relaxed text-cs2-rose-on-surface">{saveResult.error}</p> : null}
            <div>
              <p className="mb-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-cs2-emerald-on-surface">
                <Check className="h-3.5 w-3.5" aria-hidden />
                {t("analysis.cosmetics.saveResultSucceeded", {
                count: saveResult.succeeded.length
              })}
              </p>
              {saveResult.succeeded.length ? <ul className="max-h-48 space-y-2 overflow-y-auto">
                  {saveResult.succeeded.map(row => {
                const from = saveResultOriginalName(row, locale);
                const to = saveResultReplacementName(row, locale);
                return <li key={`ok-${row.slot_key || row.item_id64}`} className="text-[12px] leading-snug">
                        {from ? <span className="inline-flex flex-wrap items-center gap-1.5">
                            <span className="text-cs2-text-muted">{from}</span>
                            <ArrowRight className="h-3 w-3 shrink-0 text-cs2-text-muted" aria-hidden />
                            <span className="font-medium text-cs2-text-primary">{to}</span>
                          </span> : <span className="font-medium text-cs2-text-primary">{to}</span>}
                      </li>;
              })}
                </ul> : <p className="text-[12px] text-cs2-text-muted">{t("analysis.cosmetics.saveResultEmpty")}</p>}
            </div>
            <div>
              <p className={`mb-2 inline-flex items-center gap-1.5 text-[13px] font-semibold ${saveResult.failed.length ? "text-cs2-rose-on-surface" : "text-cs2-text-muted"}`}>
                <X className="h-3.5 w-3.5" aria-hidden />
                {t("analysis.cosmetics.saveResultFailed", {
                count: saveResult.failed.length
              })}
              </p>
              {saveResult.failed.length ? <ul className="max-h-48 space-y-2 overflow-y-auto">
                  {saveResult.failed.map(row => {
                const from = saveResultOriginalName(row, locale);
                const to = saveResultReplacementName(row, locale);
                const itemError = failedItemMessage(row, t);
                return <li key={`fail-${row.slot_key || row.item_id64}`} className="text-[12px] leading-snug">
                        {from ? <span className="inline-flex flex-wrap items-center gap-1.5">
                            <span className="text-cs2-text-muted">{from}</span>
                            <ArrowRight className="h-3 w-3 shrink-0 text-cs2-text-muted" aria-hidden />
                            <span className="font-medium text-cs2-text-primary">{to}</span>
                          </span> : <span className="font-medium text-cs2-text-primary">{to}</span>}
                        {itemError ? <span className="mt-0.5 block text-cs2-text-muted">— {itemError}</span> : null}
                      </li>;
              })}
                </ul> : <p className="text-[12px] text-cs2-text-muted">{t("analysis.cosmetics.saveResultEmpty")}</p>}
            </div>
          </div> : null}
      </Modal>
      {saving ? <SkinRewriteOverlay player={name} operations={rewriteOperations} /> : null}
    </div>
    </>;
}
