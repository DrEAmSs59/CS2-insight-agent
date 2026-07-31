/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  Gamepad2,
  Gem,
  Info,
  PackageOpen,
  Rotate3D,
  Sticker,
  WifiOff,
} from "lucide-react";
import { desktopBridge } from "../../desktop/desktopBridge.js";
import { useT } from "../../i18n/useT.js";
import { steamIdForPlayer } from "../../utils/playerAppearance.js";
import Modal from "../ui/Modal";
import { isCustomizable, itemsForTeam, slotKey, sortCosmeticsForRow } from "./cosmeticsLayout.js";
import SkinReplacementPicker from "./SkinReplacementPicker.jsx";
import { saveCustomSkinPlan } from "./saveCustomSkinPlan.js";

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
  const src = onlineAssetsEnabled && !failed ? String(item?.image_url || "") : "";
  useEffect(() => setFailed(false), [item?.image_url, onlineAssetsEnabled]);
  if (!src) {
    return (
      <span className={`flex items-center justify-center text-cs2-text-muted ${className}`}>
        {onlineAssetsEnabled ? <PackageOpen className="h-9 w-9 opacity-55" /> : <WifiOff className="h-8 w-8 opacity-55" />}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={String(item?.name_zh || item?.name_en || "")}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`object-contain ${className}`}
    />
  );
}

function CosmeticCard({ item, locale, onlineAssetsEnabled, customMode, customizable, replacementLabel, onOpen, onContextMenu, onHoverStart, onHoverEnd }) {
  const stickers = Array.isArray(item?.stickers) ? item.stickers : [];
  const rename = customName(item);
  const name = displayName(item, locale);
  const disabled = customMode && !customizable;
  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={onContextMenu}
      onPointerEnter={onHoverStart}
      onPointerLeave={onHoverEnd}
      onFocus={onHoverStart}
      onBlur={onHoverEnd}
      data-cosmetic-card
      className={`group grid w-full min-w-0 self-start grid-rows-[auto_2rem] text-left outline-none${
        disabled ? " cursor-not-allowed opacity-50 grayscale" : ""
      }`}
      aria-label={rename || name}
    >
      <span className="relative block aspect-[4/3] overflow-hidden rounded-[3px] border border-cs2-border bg-cs2-bg-input transition-colors group-hover:border-cs2-text-muted group-focus-visible:border-cs2-accent">
        <CosmeticImage item={item} onlineAssetsEnabled={onlineAssetsEnabled} className="h-full w-full p-2" />
        {onlineAssetsEnabled && stickers.length ? (
          <span className="absolute bottom-1.5 left-1.5 flex max-w-[80%] items-end gap-0.5">
            {stickers.slice(0, 5).map((sticker, index) => (
              <img key={`${sticker?.catalog_id || "sticker"}-${index}`} src={sticker?.image_url} alt="" className="h-5 w-5 object-contain drop-shadow" />
            ))}
          </span>
        ) : null}
        <span className="absolute inset-x-0 bottom-0 h-1" style={{ backgroundColor: item?.rarity || "#ded6cc" }} />
      </span>
      <span data-cosmetic-card-label className="mt-1.5 block h-8 min-w-0 overflow-hidden leading-tight">
        <span className={`block truncate ${rename ? "text-[11px] font-black text-cs2-text-primary" : "text-[10px] font-bold text-cs2-text-secondary"}`}>
          {rename ? `“${rename}”` : name}
        </span>
        {rename ? <span className="mt-0.5 block truncate text-[10px] text-cs2-text-muted">{name}</span> : null}
        {replacementLabel ? <span className="mt-0.5 block truncate text-[10px] font-semibold text-cs2-accent">{replacementLabel}</span> : null}
      </span>
    </button>
  );
}

function CosmeticsTeamRow({ team, items, locale, onlineAssetsEnabled, customMode, localReplacements, onOpen, onContextMenu, onHoverStart, onHoverEnd }) {
  const t = useT();
  const teamKey = team === "ct" ? "ct" : "t";
  return (
    <section data-testid={`cosmetics-row-${teamKey}`} className="space-y-2">
      <h3 className="text-[11px] font-black uppercase tracking-wide text-cs2-text-muted">{t(`analysis.cosmetics.team.${teamKey}`)}</h3>
      {items.length ? (
        <div className="grid grid-cols-2 items-start gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item, index) => {
            const key = slotKey(item);
            const replacement = localReplacements?.[key] || null;
            return (
            <CosmeticCard
              key={`${teamKey}-${item?.item_id || item?.catalog_id || "item"}-${index}`}
              item={item}
              locale={locale}
              onlineAssetsEnabled={onlineAssetsEnabled}
              customMode={customMode}
              customizable={isCustomizable(item)}
              replacementLabel={replacement ? t("analysis.cosmetics.replacementPreview", { name: displayName(replacement, locale) }) : null}
              onOpen={() => onOpen(item)}
              onContextMenu={(event) => onContextMenu(event, item)}
              onHoverStart={(event) => onHoverStart(event, item)}
              onHoverEnd={onHoverEnd}
            />
            );
          })}
        </div>
      ) : (
        <p className="border border-dashed border-cs2-border-subtle px-3 py-4 text-center text-[10px] text-cs2-text-muted">{t("analysis.cosmetics.noEvidence")}</p>
      )}
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
          <p className={`${customName(item) ? "mt-0.5 text-[10px] text-cs2-text-muted" : "text-[11px] font-black text-cs2-text-primary"} truncate`}>{displayName(item, locale)}</p>
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

function ItemDetail({ item, locale, onlineAssetsEnabled, onOpen3d, onInspectInGame, onCopyInspectUrl, inspectBusy }) {
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
      <div className="flex min-h-[420px] flex-col items-center justify-center border-b border-cs2-border bg-cs2-bg-page/55 p-6 lg:border-b-0 lg:border-r">
        {onlineAssetsEnabled && collection && item?.collection_image_url ? (
          <div className="mb-4 flex items-center gap-2 self-start text-[11px] text-cs2-text-secondary">
            <img src={item.collection_image_url} alt="" className="h-8 w-8 object-contain" />
            <span>{collection}</span>
          </div>
        ) : null}
        <CosmeticImage item={item} onlineAssetsEnabled={onlineAssetsEnabled} className="max-h-[360px] w-full" />
        {stickers.length && onlineAssetsEnabled ? (
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            {stickers.map((sticker, index) => (
              <div key={`${sticker?.catalog_id || "sticker"}-${index}`} className="text-center">
                <img src={sticker?.image_url} alt="" className="h-14 w-14 object-contain" />
                <span className="mt-1 block max-w-20 truncate text-[9px] text-cs2-text-muted">{localized(sticker, "name", locale)}</span>
              </div>
            ))}
          </div>
        ) : stickers.length ? (
          <div className="mt-4 inline-flex items-center gap-1.5 text-[10px] text-cs2-text-muted"><WifiOff className="h-3.5 w-3.5" />{t("analysis.cosmetics.onlineAssetsOff")}</div>
        ) : (
          <div className="mt-4 inline-flex items-center gap-1.5 text-[10px] text-cs2-text-muted"><Sticker className="h-3.5 w-3.5" />{t("analysis.cosmetics.noStickerEvidence")}</div>
        )}
      </div>
      <div className="min-w-0 p-5">
        <div className="mb-4 border-b border-cs2-border pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {customName(item) ? <p className="break-words text-base font-black text-cs2-text-primary">“{customName(item)}”</p> : null}
              <p className={`${customName(item) ? "mt-1 text-[11px] text-cs2-text-muted" : "text-sm font-black text-cs2-text-primary"}`}>{displayName(item, locale)}</p>
              {item?.alt_name ? <p className="mt-1 font-mono text-[9px] text-cs2-text-muted">{item.alt_name}</p> : null}
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
        <div className="mt-5 grid grid-cols-3 border border-cs2-border">
          <button data-cosmetic-open-3d type="button" disabled={!canInspect3d(item, onlineAssetsEnabled)} onClick={onOpen3d} className="inline-flex h-10 items-center justify-center gap-2 border-r border-cs2-border text-[11px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-35"><Rotate3D className="h-4 w-4" />{t("analysis.cosmetics.inspect3d")}</button>
          <button type="button" disabled={!canInspectInGame(item) || inspectBusy} onClick={onInspectInGame} className="inline-flex h-10 items-center justify-center gap-2 border-r border-cs2-border text-[11px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-35"><Gamepad2 className="h-4 w-4" />{t("analysis.cosmetics.inspectInGame")}</button>
          <button type="button" disabled={!canInspectInGame(item) || inspectBusy} onClick={onCopyInspectUrl} className="inline-flex h-10 items-center justify-center gap-2 text-[11px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-35"><Copy className="h-4 w-4" />{t("analysis.cosmetics.copyInspectUrl")}</button>
        </div>
      </div>
    </div>
  );
}

export default function CosmeticsView({ workspace, selectedPlayer, locale = "zh", onlineAssetsEnabled = false }) {
  const t = useT();
  const name = playerName(selectedPlayer);
  const workspacePlayer = useMemo(() => {
    const target = name.toLocaleLowerCase();
    return (workspace?.players || []).find((player) => playerName(player).toLocaleLowerCase() === target) || null;
  }, [name, workspace?.players]);
  const steamid = steamIdForPlayer(workspacePlayer) || steamIdForPlayer(selectedPlayer);
  const [detail, setDetail] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [hoverCard, setHoverCard] = useState(null);
  const [notice, setNotice] = useState(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [viewMode, setViewMode] = useState("browse");
  const [localReplacements, setLocalReplacements] = useState({});
  const [pickerItem, setPickerItem] = useState(null);
  const [saving, setSaving] = useState(false);
  const inventory = useMemo(() => {
    const rows = workspace?.cosmetics?.players?.[steamid];
    return Array.isArray(rows) ? rows : [];
  }, [steamid, workspace?.cosmetics?.players]);
  const ctItems = useMemo(
    () => sortCosmeticsForRow(itemsForTeam(inventory, "ct"), locale),
    [inventory, locale],
  );
  const tItems = useMemo(
    () => sortCosmeticsForRow(itemsForTeam(inventory, "t"), locale),
    [inventory, locale],
  );
  const browseMode = viewMode === "browse";
  const hasReplacements = Object.keys(localReplacements).length > 0;

  useEffect(() => {
    setDetail(null);
    setContextMenu(null);
    setHoverCard(null);
    setNotice(null);
    setViewMode("browse");
    setLocalReplacements({});
    setPickerItem(null);
    setSaving(false);
  }, [steamid]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = (event) => {
      if (event?.target?.closest?.("[data-cosmetic-context-menu]")) return;
      setContextMenu(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

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

  const openContext = (event, item) => {
    if (!browseMode) return;
    event.preventDefault();
    setHoverCard(null);
    setContextMenu({
      item,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 224)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)),
    });
  };

  const openHover = (event, item) => {
    if (!browseMode || contextMenu || detail) return;
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

  const inspectInGame = async (item) => {
    setContextMenu(null);
    setInspectBusy(true);
    try {
      const { buildCs2InspectLink } = await import("../../utils/cs2Inspect.js");
      const link = buildCs2InspectLink(item);
      if (link.startsWith("steam://") && desktopBridge?.openExternal) {
        await desktopBridge.openExternal(link);
        setNotice({ tone: "success", text: t("analysis.cosmetics.inspectLaunched") });
      } else {
        await writeClipboard(link);
        setNotice({ tone: "success", text: t("analysis.cosmetics.inspectCommandCopied") });
      }
    } catch {
      setNotice({ tone: "error", text: t("analysis.cosmetics.inspectFailed") });
    } finally {
      setInspectBusy(false);
    }
  };

  const copyInspectUrl = async (item) => {
    setContextMenu(null);
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

  const openCard = (item) => {
    if (browseMode) {
      openItemDetail(item);
      return;
    }
    if (isCustomizable(item)) {
      setPickerItem(item);
    }
  };

  const cancelCustomize = () => {
    setLocalReplacements({});
    setPickerItem(null);
    setViewMode("browse");
  };

  const confirmReplacement = (replacement) => {
    if (!pickerItem) return;
    setLocalReplacements((prev) => ({ ...prev, [slotKey(pickerItem)]: replacement }));
    setPickerItem(null);
  };

  const savePlan = async () => {
    if (!hasReplacements || saving) return;
    setSaving(true);
    try {
      const result = await saveCustomSkinPlan({ steamid, replacements: localReplacements });
      if (result?.ok) {
        setNotice({ tone: "success", text: t("analysis.cosmetics.saveStubSuccess") });
        setViewMode("browse");
        setPickerItem(null);
      } else {
        setNotice({ tone: "error", text: t("analysis.cosmetics.saveFailed") });
      }
    } catch {
      setNotice({ tone: "error", text: t("analysis.cosmetics.saveFailed") });
    } finally {
      setSaving(false);
    }
  };

  const open3d = (item) => {
    setContextMenu(null);
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
              onClick={() => setViewMode("custom")}
              className="inline-flex h-8 items-center gap-1.5 border border-cs2-border bg-cs2-bg-input px-3 text-[10px] font-bold text-cs2-text-secondary hover:border-cs2-text-muted hover:text-cs2-text-primary"
            >
              {t("analysis.cosmetics.customize")}
            </button>
          ) : (
            <>
              <p className="text-[10px] text-cs2-text-muted">{t("analysis.cosmetics.customizingHint")}</p>
              <button
                type="button"
                onClick={cancelCustomize}
                className="inline-flex h-8 items-center border border-cs2-border px-3 text-[10px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
              >
                {t("analysis.cosmetics.cancelCustomize")}
              </button>
              <button
                type="button"
                disabled={!hasReplacements || saving}
                onClick={() => void savePlan()}
                className="inline-flex h-8 items-center border border-cs2-accent/40 bg-cs2-accent/10 px-3 text-[10px] font-bold text-cs2-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("analysis.cosmetics.savePlan")}
              </button>
            </>
          )}
        </div>
      </div>

      {notice ? (
        <div className={`mb-3 flex items-center gap-2 border px-3 py-2 text-[10px] ${notice.tone === "error" ? "border-rose-500/40 bg-rose-500/10 text-rose-300" : "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"}`}>
          {notice.tone === "error" ? <Info className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}{notice.text}
        </div>
      ) : null}

      {!onlineAssetsEnabled ? (
        <div className="mb-3 flex items-center gap-2 border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[10px] text-cs2-text-muted"><WifiOff className="h-3.5 w-3.5" />{t("analysis.cosmetics.onlineAssetsOff")}</div>
      ) : null}

      {inventory.length ? (
        <div className="space-y-6">
          <CosmeticsTeamRow
            team="ct"
            items={ctItems}
            locale={locale}
            onlineAssetsEnabled={onlineAssetsEnabled}
            customMode={!browseMode}
            localReplacements={localReplacements}
            onOpen={openCard}
            onContextMenu={openContext}
            onHoverStart={openHover}
            onHoverEnd={() => setHoverCard(null)}
          />
          <CosmeticsTeamRow
            team="t"
            items={tItems}
            locale={locale}
            onlineAssetsEnabled={onlineAssetsEnabled}
            customMode={!browseMode}
            localReplacements={localReplacements}
            onOpen={openCard}
            onContextMenu={openContext}
            onHoverStart={openHover}
            onHoverEnd={() => setHoverCard(null)}
          />
        </div>
      ) : (
        <div className="flex min-h-[300px] items-center justify-center border border-dashed border-cs2-border bg-cs2-bg-page/25 p-8 text-center">
          <div><Box className="mx-auto h-7 w-7 text-cs2-text-muted" /><h3 className="mt-3 text-[12px] font-bold text-cs2-text-primary">{t("analysis.cosmetics.noEvidence")}</h3><p className="mt-1 max-w-md text-[10px] leading-relaxed text-cs2-text-muted">{t("analysis.cosmetics.noEvidenceHint")}</p></div>
        </div>
      )}

      {hoverCard ? <HoverDetails item={hoverCard.item} locale={locale} position={hoverCard.position} /> : null}

      {contextMenu ? createPortal(
        <div
          data-cosmetic-context-menu
          role="menu"
          className="fixed z-[1000] w-[216px] rounded-md border border-slate-200 bg-white p-1.5 shadow-[0_8px_28px_rgba(15,23,42,0.22)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button type="button" role="menuitem" disabled={!canInspectInGame(contextMenu.item) || inspectBusy} onClick={() => void inspectInGame(contextMenu.item)} className="flex h-9 w-full items-center gap-3 rounded px-3 text-left text-[13px] font-semibold text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"><ExternalLink className="h-[18px] w-[18px] text-slate-500" strokeWidth={1.8} />{t("analysis.cosmetics.inspectInGame")}</button>
          <button type="button" role="menuitem" disabled={!canInspectInGame(contextMenu.item) || inspectBusy} onClick={() => void copyInspectUrl(contextMenu.item)} className="flex h-9 w-full items-center gap-3 rounded px-3 text-left text-[13px] font-semibold text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35"><Copy className="h-[18px] w-[18px] text-slate-500" strokeWidth={1.8} />{t("analysis.cosmetics.copyInspectUrl")}</button>
        </div>,
        document.body,
      ) : null}

      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail ? (customName(detail.item) || displayName(detail.item, locale)) : ""}
        subtitle={detail?.mode === "3d" ? t("analysis.cosmetics.inspect3d") : localized(detail?.item, "collection_name", locale) || t("analysis.cosmetics.itemInfo")}
        icon={detail?.mode === "3d" ? <Rotate3D className="h-4 w-4 text-cs2-accent" /> : <Gem className="h-4 w-4 text-cs2-accent" />}
        maxWidth="max-w-6xl"
        maxHeight="max-h-[90vh]"
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
          <ItemDetail item={detail.item} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} onOpen3d={() => open3d(detail.item)} onInspectInGame={() => void inspectInGame(detail.item)} onCopyInspectUrl={() => void copyInspectUrl(detail.item)} inspectBusy={inspectBusy} />
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
    </div>
  );
}
