import { useEffect, useMemo, useState } from "react";
import { PackageOpen, Shuffle, WifiOff } from "lucide-react";
import { useT } from "../../i18n/useT.js";
import Modal from "../ui/Modal.jsx";
import { craftNameParts, filterCandidates, imageUrlForWear, listSkinCandidates } from "./cosmeticsCatalog.js";

const WEAR_MIN = 0;
const WEAR_MAX = 1;
const SEED_MIN = 0;
const SEED_MAX = 1000;

function displayName(item, locale) {
  return craftNameParts(item, locale).full;
}

function finishNameColor(item) {
  return String(item?.rarity || "").trim() || "#ded6cc";
}

function ItemCaption({ item, locale, compact = false, inline = false }) {
  if (!item) {
    return <span className="text-sm text-cs2-text-muted">—</span>;
  }
  const { model, finish, alt, full } = craftNameParts(item, locale);
  const color = finishNameColor(item);

  if (inline) {
    const parts = [];
    if (model) parts.push({ text: model, className: "text-cs2-text-primary" });
    if (finish) parts.push({ text: finish, className: "font-semibold", style: { color } });
    if (!model && !finish && full) parts.push({ text: full, className: "text-cs2-text-primary" });
    if (alt) parts.push({ text: alt, className: "text-cs2-text-secondary" });
    return (
      <span className="block min-w-0 truncate text-[11px] leading-tight" title={parts.map((p) => p.text).join(" | ")}>
        {parts.map((part, index) => (
          <span key={`${part.text}-${index}`}>
            {index > 0 ? <span className="text-cs2-text-muted"> | </span> : null}
            <span className={part.className} style={part.style}>{part.text}</span>
          </span>
        ))}
      </span>
    );
  }

  const modelClass = compact
    ? "truncate text-[11px] text-cs2-text-primary"
    : "break-words text-sm text-cs2-text-primary";
  const finishClass = compact
    ? "truncate text-[11px] font-semibold"
    : "break-words text-sm font-semibold";
  const altClass = compact
    ? "truncate text-[10px] text-cs2-text-secondary"
    : "break-words text-[11px] text-cs2-text-secondary";
  return (
    <span className="flex min-w-0 flex-col gap-0.5 leading-snug">
      {model ? <span className={modelClass}>{model}</span> : null}
      {finish ? <span className={finishClass} style={{ color }}>{finish}</span> : null}
      {!finish && !model ? <span className={modelClass}>{full}</span> : null}
      {alt ? <span className={altClass}>{alt}</span> : null}
    </span>
  );
}

function formatWear(value) {
  const wear = Number(value);
  if (!Number.isFinite(wear)) return "";
  return wear.toFixed(6);
}

function isValidWear(value) {
  const wear = Number(value);
  return Number.isFinite(wear) && wear >= WEAR_MIN && wear <= WEAR_MAX;
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

function randomWear() {
  return formatWear(Math.random() * (WEAR_MAX - WEAR_MIN) + WEAR_MIN);
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
  readOnly,
  kind,
  invalidText,
}) {
  const t = useT();
  const isWear = kind === "wear";
  const numeric = Number(value);
  const sliderValue = Number.isFinite(numeric)
    ? Math.min(isWear ? WEAR_MAX : SEED_MAX, Math.max(isWear ? WEAR_MIN : SEED_MIN, numeric))
    : (isWear ? WEAR_MIN : SEED_MIN);

  return (
    <label className="flex max-w-[256px] shrink-0 flex-col gap-0.5 text-[11px]">
      <span className="text-cs2-text-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode={isWear ? "decimal" : "numeric"}
          readOnly={readOnly}
          disabled={readOnly}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          className="w-[84px] shrink-0 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1 font-mono text-[11px] text-cs2-text-primary outline-none focus:border-cs2-accent disabled:cursor-not-allowed disabled:opacity-60"
        />
        <input
          type="range"
          min={isWear ? WEAR_MIN : SEED_MIN}
          max={isWear ? WEAR_MAX : SEED_MAX}
          step={isWear ? 0.000001 : 1}
          disabled={readOnly}
          value={sliderValue}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange?.(isWear ? formatWear(next) : String(Math.round(next)));
          }}
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-cs2-accent disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          disabled={readOnly}
          onClick={onRandom}
          title={t("analysis.cosmetics.picker.random")}
          aria-label={t("analysis.cosmetics.picker.random")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-cs2-border bg-cs2-bg-input text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Shuffle className="h-3.5 w-3.5" />
        </button>
      </div>
      {invalidText ? <span className="text-[10px] text-red-400">{invalidText}</span> : null}
    </label>
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
}) {
  const t = useT();
  return (
    <div className="flex w-[256px] shrink-0 flex-col gap-1">
      <span className="shrink-0 text-xs font-medium text-cs2-text-muted">{label}</span>
      <div
        data-skin-tile
        className="flex h-[192px] w-[256px] shrink-0 items-center justify-center overflow-hidden rounded border border-cs2-border bg-cs2-bg-input"
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
      <ItemCaption item={item} locale={locale} inline />
      <ParamRow
        label={t("analysis.cosmetics.picker.wear")}
        kind="wear"
        value={wear}
        readOnly={!wearEditable}
        onChange={onWearChange}
        onRandom={() => onWearChange?.(randomWear())}
        invalidText={wearInvalid}
      />
      <ParamRow
        label={t("analysis.cosmetics.picker.seed")}
        kind="seed"
        value={seed}
        readOnly={!seedEditable}
        onChange={onSeedChange}
        onRandom={() => onSeedChange?.(randomSeed())}
        invalidText={seedInvalid}
      />
    </div>
  );
}

export default function SkinReplacementPicker({
  open,
  sourceItem,
  locale,
  onlineAssetsEnabled,
  onClose,
  onConfirm,
}) {
  const t = useT();
  const candidates = useMemo(() => listSkinCandidates(sourceItem), [sourceItem]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [wear, setWear] = useState("");
  const [seed, setSeed] = useState("");

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
  }, [open, sourceItem]);

  const filtered = useMemo(
    () => filterCandidates(candidates, query, locale),
    [candidates, query, locale],
  );

  const replacementPreview = selected
    ? { ...selected, paint_wear: wear, paint_seed: seed }
    : null;

  const wearValid = isValidWear(wear);
  const seedValid = isValidSeed(seed);
  const canConfirm = Boolean(selected) && wearValid && seedValid;

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
            className="rounded border border-cs2-border px-4 py-2 text-sm text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover"
          >
            {t("analysis.cosmetics.picker.cancel")}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded bg-cs2-accent px-4 py-2 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("analysis.cosmetics.picker.confirm")}
          </button>
        </div>
      )}
    >
      <div className="grid h-[min(720px,calc(90vh-8.5rem))] grid-cols-[256px_minmax(0,1fr)] gap-5 overflow-hidden p-4">
        <div className="flex min-h-0 flex-col justify-between gap-3 overflow-hidden pr-0.5">
          <SkinColumn
            item={sourceItem}
            locale={locale}
            onlineAssetsEnabled={onlineAssetsEnabled}
            label={t("analysis.cosmetics.picker.current")}
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
            wear={wear}
            seed={seed}
            wearEditable
            seedEditable
            onWearChange={setWear}
            onSeedChange={setSeed}
            wearInvalid={wearValid ? null : t("analysis.cosmetics.picker.wearInvalid")}
            seedInvalid={seedValid ? null : t("analysis.cosmetics.picker.seedInvalid")}
          />
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
            className="w-full shrink-0 rounded border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary outline-none focus:border-cs2-accent"
          />
          <div
            data-testid="skin-candidate-list"
            className="grid min-h-0 min-w-0 flex-1 auto-rows-min grid-cols-3 content-start gap-3 overflow-y-auto overflow-x-hidden pr-1"
          >
            {filtered.map((candidate) => {
              const active = selected?.catalog_id === candidate.catalog_id
                && selected?.paint_index === candidate.paint_index;
              return (
                <button
                  key={`${candidate.catalog_id}-${candidate.paint_index}`}
                  type="button"
                  onClick={() => setSelected(candidate)}
                  aria-pressed={active}
                  aria-label={[displayName(candidate, locale), craftNameParts(candidate, locale).alt].filter(Boolean).join(" ")}
                  data-skin-tile
                  className={`relative box-border flex h-[192px] w-full min-w-0 shrink-0 flex-col overflow-hidden rounded border text-left transition-colors ${
                    active
                      ? "border-cs2-accent bg-cs2-bg-hover"
                      : "border-cs2-border bg-cs2-bg-input hover:border-cs2-text-muted"
                  }`}
                >
                  <div className="min-h-0 flex-1">
                    <TileImage item={candidate} locale={locale} onlineAssetsEnabled={onlineAssetsEnabled} />
                  </div>
                  <span className="absolute inset-x-0 bottom-0 bg-black/65 px-2 py-1">
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
