import { useEffect, useMemo, useState } from "react";
import { Gamepad2, Loader2, PackageOpen, Rotate3D, Shuffle, WifiOff } from "lucide-react";
import { useT } from "../../../i18n/useT.js";
import Modal from "../../../components/ui/Modal.jsx";
import {
  candidateTypeGroupKey,
  craftNameParts,
  filterCandidates,
  formatCraftPipeName,
  imageUrlForWear,
  listCandidateTypeGroups,
  listSkinCandidates,
} from "./cosmeticsCatalog.js";

const WEAR_MIN = 0;
const WEAR_MAX = 1;
const SEED_MIN = 0;
const SEED_MAX = 1000;

function displayName(item, locale) {
  return craftNameParts(item, locale).full;
}

function ItemCaption({ item, locale, compact = false }) {
  if (!item) {
    return <span className="text-sm text-cs2-text-muted">—</span>;
  }
  const parts = craftNameParts(item, locale);
  const rarityColor = String(item?.rarity || "").trim() || "#ded6cc";
  const sizeClass = compact ? "text-[11px]" : "text-sm";
  const label = formatCraftPipeName(item, locale) || displayName(item, locale);
  const sep = <span className="text-cs2-text-muted"> | </span>;
  const hasModel = Boolean(parts.model);
  const hasFinish = Boolean(parts.finish);
  const hasAlt = Boolean(parts.alt);
  const fallback = !hasModel && !hasFinish && !hasAlt ? parts.full : "";
  return (
    <span className={`block min-w-0 break-words font-semibold leading-snug ${sizeClass}`} title={label}>
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
  );
}

function formatWear(value) {
  const wear = Number(value);
  if (!Number.isFinite(wear)) return "";
  return wear.toFixed(6);
}

function wearBounds(item) {
  const rawMin = item?.wear_min;
  const rawMax = item?.wear_max;
  const parsedMin = rawMin === "" || rawMin === null || rawMin === undefined
    ? WEAR_MIN
    : Number(rawMin);
  const parsedMax = rawMax === "" || rawMax === null || rawMax === undefined
    ? WEAR_MAX
    : Number(rawMax);
  const min = Number.isFinite(parsedMin)
    ? Math.min(WEAR_MAX, Math.max(WEAR_MIN, parsedMin))
    : WEAR_MIN;
  const max = Number.isFinite(parsedMax)
    ? Math.min(WEAR_MAX, Math.max(WEAR_MIN, parsedMax))
    : WEAR_MAX;
  return min <= max ? { min, max } : { min: WEAR_MIN, max: WEAR_MAX };
}

function isValidWear(value, min = WEAR_MIN, max = WEAR_MAX) {
  const wear = Number(value);
  return Number.isFinite(wear) && wear >= min && wear <= max;
}

function isValidSeed(value) {
  if (value === "" || value === null || value === undefined) return false;
  const seed = Number(value);
  return Number.isInteger(seed) && seed >= SEED_MIN && seed <= SEED_MAX;
}

function parseSeed(value) {
  const seed = Number(value);
  return Number.isInteger(seed) && seed >= SEED_MIN && seed <= SEED_MAX ? seed : null;
}

function randomWear(min = WEAR_MIN, max = WEAR_MAX) {
  return formatWear(Math.random() * (max - min) + min);
}

function randomSeed() {
  return String(SEED_MIN + Math.floor(Math.random() * (SEED_MAX - SEED_MIN + 1)));
}

function TileImage({ item, onlineAssetsEnabled, locale = "zh", wear, className = "" }) {
  const [failed, setFailed] = useState(false);
  const base = onlineAssetsEnabled ? String(item?.image_url || "") : "";
  const wearNum = wear === "" || wear === null || wear === undefined
    ? undefined
    : Number(wear);
  const src = onlineAssetsEnabled && !failed
    ? imageUrlForWear(base, Number.isFinite(wearNum) ? wearNum : undefined, item)
    : "";

  useEffect(() => setFailed(false), [item?.image_url, item?.paint_index, item?.is_placeholder, onlineAssetsEnabled, wear]);

  if (!src) {
    return (
      <span className={`flex h-full w-full items-center justify-center text-cs2-text-muted ${className}`}>
        {onlineAssetsEnabled ? <PackageOpen className="h-9 w-9 opacity-55" /> : <WifiOff className="h-8 w-8 opacity-55" />}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={displayName(item, locale)}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`h-full w-full object-contain p-2 ${className}`}
    />
  );
}

function ParamRow({
  label,
  value,
  onChange,
  onRandom,
  kind,
  invalidText,
  minValue,
  maxValue,
}) {
  const t = useT();
  const isWear = kind === "wear";
  const min = isWear ? minValue : SEED_MIN;
  const max = isWear ? maxValue : SEED_MAX;
  const numeric = Number(value);
  const sliderValue = Number.isFinite(numeric)
    ? Math.min(max, Math.max(min, numeric))
    : min;
  const sliderProgress = max > min
    ? Math.max(0, Math.min(100, ((sliderValue - min) / (max - min)) * 100))
    : 0;

  return (
    <label className="flex w-full min-w-0 shrink-0 flex-col gap-0.5 text-[11px]">
      <span className="flex items-center justify-between gap-2 text-cs2-text-muted">
        <span>{label}</span>
        {isWear ? (
          <span className="font-mono text-[9px] text-cs2-text-secondary">
            {formatWear(min)}–{formatWear(max)}
          </span>
        ) : null}
      </span>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode={isWear ? "decimal" : "numeric"}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          aria-invalid={Boolean(invalidText)}
          className="w-[84px] shrink-0 rounded-[8px] border border-cs2-border bg-cs2-bg-input px-2 py-1 font-mono text-[11px] text-cs2-text-primary outline-none focus:border-cs2-accent"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={isWear ? 0.000001 : 1}
          value={sliderValue}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange?.(isWear ? formatWear(next) : String(Math.round(next)));
          }}
          className="cs2-data-slider min-w-0 flex-1"
          style={{ "--cs2-range-progress": `${sliderProgress}%` }}
        />
        <button
          type="button"
          onClick={onRandom}
          title={t("analysis.cosmetics.picker.random")}
          aria-label={t("analysis.cosmetics.picker.random")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border border-cs2-border bg-cs2-bg-input text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
        >
          <Shuffle className="h-3.5 w-3.5" />
        </button>
      </div>
      {invalidText ? <span className="text-[10px] text-red-400">{invalidText}</span> : null}
    </label>
  );
}

function ParamValue({ label, value }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-cs2-border-subtle py-1.5 text-[11px] last:border-b-0">
      <span className="text-cs2-text-muted">{label}</span>
      <output className="min-w-0 text-right font-mono font-semibold text-cs2-text-secondary">
        {value === "" || value === null || value === undefined ? "—" : value}
      </output>
    </div>
  );
}

function SkinColumn({
  item,
  locale,
  onlineAssetsEnabled,
  label,
  wear,
  seed,
  wearEditable,
  seedEditable,
  onWearChange,
  onSeedChange,
  wearInvalid,
  seedInvalid,
  wearMin = WEAR_MIN,
  wearMax = WEAR_MAX,
  testId,
}) {
  const t = useT();
  return (
    <div data-testid={testId} className="flex w-full min-w-0 shrink-0 flex-col gap-1">
      <span className="shrink-0 text-xs font-medium text-cs2-text-muted">{label}</span>
      <div
        data-skin-tile
        className="cosmetic-preview-surface flex h-[192px] w-full shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-cs2-border"
      >
        <TileImage
          item={item}
          locale={locale}
          onlineAssetsEnabled={onlineAssetsEnabled}
          wear={wear === "" || wear === null || wear === undefined
            ? undefined
            : (Number.isFinite(Number(wear)) ? Number(wear) : undefined)}
        />
      </div>
      <ItemCaption item={item} locale={locale} />
      {wearEditable ? (
        <ParamRow
          label={t("analysis.cosmetics.picker.wear")}
          kind="wear"
          value={wear}
          onChange={onWearChange}
          onRandom={() => onWearChange?.(randomWear(wearMin, wearMax))}
          invalidText={wearInvalid}
          minValue={wearMin}
          maxValue={wearMax}
        />
      ) : (
        <ParamValue label={t("analysis.cosmetics.picker.wear")} value={wear} />
      )}
      {seedEditable ? (
        <ParamRow
          label={t("analysis.cosmetics.picker.seed")}
          kind="seed"
          value={seed}
          onChange={onSeedChange}
          onRandom={() => onSeedChange?.(randomSeed())}
          invalidText={seedInvalid}
        />
      ) : (
        <ParamValue label={t("analysis.cosmetics.picker.seed")} value={seed} />
      )}
    </div>
  );
}

export default function SkinReplacementPicker({
  open,
  sourceItem,
  locale,
  onlineAssetsEnabled,
  inspectBusy = false,
  inspectFeedback = null,
  onClose,
  onConfirm,
  onInspectInGame,
  onInspect3d,
}) {
  const t = useT();
  const candidates = useMemo(() => listSkinCandidates(sourceItem), [sourceItem]);
  const typeGroups = useMemo(
    () => listCandidateTypeGroups(candidates, locale),
    [candidates, locale],
  );
  const defaultTypeGroup = useMemo(() => {
    if (typeGroups.length <= 1) return "";
    const sourceGroup = candidateTypeGroupKey(sourceItem);
    if (typeGroups.some((group) => group.key === sourceGroup)) return sourceGroup;
    return typeGroups[0]?.key || "";
  }, [sourceItem, typeGroups]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [wear, setWear] = useState("");
  const [seed, setSeed] = useState("");
  const [activeTypeGroup, setActiveTypeGroup] = useState("");

  const currentWear = formatWear(sourceItem?.paint_wear) || String(sourceItem?.paint_wear ?? "");
  const currentSeed = sourceItem?.paint_seed === undefined || sourceItem?.paint_seed === null
    ? ""
    : String(Math.trunc(Number(sourceItem.paint_seed)));

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(null);
    setWear(formatWear(WEAR_MIN));
    setSeed(String(SEED_MIN));
    setActiveTypeGroup(defaultTypeGroup);
  }, [defaultTypeGroup, open, sourceItem]);

  const filtered = useMemo(
    () => filterCandidates(candidates, query, locale, activeTypeGroup),
    [activeTypeGroup, candidates, query, locale],
  );
  const selectedWearBounds = useMemo(() => wearBounds(selected), [selected]);

  const selectTypeGroup = (key) => {
    setActiveTypeGroup(key);
    setSelected(null);
  };

  const selectCandidate = (candidate) => {
    const bounds = wearBounds(candidate);
    setSelected(candidate);
    setWear((current) => {
      const numeric = Number(current);
      const next = Number.isFinite(numeric)
        ? Math.min(bounds.max, Math.max(bounds.min, numeric))
        : bounds.min;
      return formatWear(next);
    });
  };

  const replacementPreview = selected
    ? { ...selected, paint_wear: Number(wear), paint_seed: Number(seed) }
    : null;

  const wearValid = isValidWear(wear, selectedWearBounds.min, selectedWearBounds.max);
  const seedValid = isValidSeed(seed);
  const canConfirm = Boolean(selected) && wearValid && seedValid;
  const canInspect3d = canConfirm
    && onlineAssetsEnabled
    && ["weapon", "melee"].includes(String(selected?.type || ""));

  const handleConfirm = () => {
    if (!canConfirm || !selected) return;
    onConfirm({
      catalog_id: selected.catalog_id,
      def_index: selected.def_index,
      paint_index: selected.paint_index,
      model: selected.model,
      type: selected.type,
      name_en: selected.name_en,
      name_zh: selected.name_zh,
      alt_name: selected.alt_name,
      image_url: selected.image_url,
      rarity: selected.rarity,
      wear_min: selectedWearBounds.min,
      wear_max: selectedWearBounds.max,
      paint_wear: Number(wear),
      paint_seed: parseSeed(seed),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("analysis.cosmetics.picker.title", { name: displayName(sourceItem, locale) })}
      maxWidth="max-w-[1180px]"
      maxHeight="max-h-[90vh]"
      className="!h-auto"
      contentClassName="min-h-0 overflow-hidden"
      footer={(
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[10px] border border-cs2-border bg-cs2-bg-input px-4 py-2 text-sm text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover"
          >
            {t("analysis.cosmetics.picker.cancel")}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded-[10px] bg-cs2-accent px-4 py-2 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("analysis.cosmetics.picker.confirm")}
          </button>
        </div>
      )}
    >
      <div className="grid h-[min(720px,calc(90vh-8.5rem))] grid-cols-[256px_minmax(0,1fr)] gap-5 overflow-hidden p-4">
        <div
          data-testid="skin-picker-current-column"
          className="flex min-h-0 flex-col justify-between gap-3 overflow-y-auto overflow-x-hidden pr-1"
        >
          <SkinColumn
            item={sourceItem}
            locale={locale}
            onlineAssetsEnabled={onlineAssetsEnabled}
            label={t("analysis.cosmetics.picker.current")}
            testId="skin-picker-current"
            wear={currentWear}
            seed={currentSeed}
            wearEditable={false}
            seedEditable={false}
          />
          <SkinColumn
            item={replacementPreview}
            locale={locale}
            onlineAssetsEnabled={onlineAssetsEnabled}
            label={t("analysis.cosmetics.picker.replacement")}
            testId="skin-picker-replacement"
            wear={wear}
            seed={seed}
            wearEditable
            seedEditable
            onWearChange={setWear}
            onSeedChange={setSeed}
            wearInvalid={wearValid ? null : t("analysis.cosmetics.picker.wearInvalid", {
              min: formatWear(selectedWearBounds.min),
              max: formatWear(selectedWearBounds.max),
            })}
            seedInvalid={seedValid ? null : t("analysis.cosmetics.picker.seedInvalid")}
            wearMin={selectedWearBounds.min}
            wearMax={selectedWearBounds.max}
          />
          <div className="grid grid-cols-2 gap-2" data-testid="skin-picker-inspect-actions">
            <button
              type="button"
              disabled={!canConfirm || inspectBusy}
              onClick={() => onInspectInGame?.(replacementPreview)}
              className="inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-[8px] border border-cs2-border bg-cs2-bg-input px-2 text-[10px] font-bold text-cs2-text-secondary transition-colors hover:border-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {inspectBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gamepad2 className="h-3.5 w-3.5" />}
              {t("analysis.cosmetics.inspectInGame")}
            </button>
            <button
              type="button"
              disabled={!canInspect3d}
              onClick={() => onInspect3d?.(replacementPreview)}
              className="inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-[8px] border border-cs2-border bg-cs2-bg-input px-2 text-[10px] font-bold text-cs2-text-secondary transition-colors hover:border-cs2-text-muted hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Rotate3D className="h-3.5 w-3.5" />
              {t("analysis.cosmetics.inspect3d")}
            </button>
          </div>
          {inspectFeedback ? <p role={inspectFeedback.tone === "error" ? "alert" : "status"} className={`text-[9px] leading-relaxed ${inspectFeedback.tone === "error" ? "text-rose-300" : "text-emerald-300"}`}>{inspectFeedback.text}</p> : null}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
          <div className="shrink-0 text-xs font-medium text-cs2-text-muted">
            {t("analysis.cosmetics.picker.candidates")}
          </div>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("analysis.cosmetics.picker.search")}
            className="w-full shrink-0 rounded-[10px] border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary outline-none focus:border-cs2-accent"
          />
          {typeGroups.length > 1 ? (
            <div data-testid="skin-type-filters" className="shrink-0">
              <div className="mb-1.5 text-[11px] font-medium text-cs2-text-muted">
                {String(sourceItem?.type || "") === "glove"
                  ? t("analysis.cosmetics.picker.gloveTypes")
                  : t("analysis.cosmetics.picker.knifeTypes")}
              </div>
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
                <button
                  type="button"
                  aria-pressed={!activeTypeGroup}
                  onClick={() => selectTypeGroup("")}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    !activeTypeGroup
                      ? "border-cs2-accent bg-cs2-accent/15 text-cs2-accent"
                      : "border-cs2-border bg-cs2-bg-input text-cs2-text-secondary hover:border-cs2-text-muted"
                  }`}
                >
                  {t("analysis.cosmetics.picker.allTypes")} · {candidates.length}
                </button>
                {typeGroups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    aria-pressed={activeTypeGroup === group.key}
                    onClick={() => selectTypeGroup(group.key)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                      activeTypeGroup === group.key
                        ? "border-cs2-accent bg-cs2-accent/15 text-cs2-accent"
                        : "border-cs2-border bg-cs2-bg-input text-cs2-text-secondary hover:border-cs2-text-muted"
                    }`}
                  >
                    {group.label} · {group.count}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div
            data-testid="skin-candidate-list"
            className="grid min-h-0 min-w-0 flex-1 auto-rows-min grid-cols-5 content-start gap-2 overflow-y-auto overflow-x-hidden pr-1"
          >
            {filtered.map((candidate) => {
              const active = selected?.catalog_id === candidate.catalog_id
                && selected?.paint_index === candidate.paint_index;
              return (
                <button
                  key={`${candidate.catalog_id}-${candidate.paint_index}`}
                  type="button"
                  onClick={() => selectCandidate(candidate)}
                  aria-pressed={active}
                  aria-label={formatCraftPipeName(candidate, locale) || displayName(candidate, locale)}
                  data-skin-tile
                  className={`cosmetic-preview-surface relative box-border flex h-[128px] w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-[10px] border text-left transition-colors ${
                    active
                      ? "border-cs2-accent ring-1 ring-cs2-accent/40"
                      : "border-cs2-border hover:border-cs2-text-muted"
                  }`}
                >
                  <div className="min-h-0 flex-1">
                    <TileImage item={candidate} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} />
                  </div>
                  <span data-skin-caption className="absolute inset-x-0 bottom-0 border-t border-cs2-border bg-cs2-bg-card px-2 py-1">
                    <ItemCaption item={candidate} locale={locale} compact />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
