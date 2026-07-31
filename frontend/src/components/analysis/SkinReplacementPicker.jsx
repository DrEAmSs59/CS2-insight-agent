import { useEffect, useMemo, useState } from "react";
import { PackageOpen, WifiOff } from "lucide-react";
import { useT } from "../../i18n/useT.js";
import Modal from "../ui/Modal.jsx";
import { filterCandidates, listSkinCandidates } from "./cosmeticsCatalog.js";

function displayName(item, locale) {
  const chinese = String(item?.name_zh || "").trim();
  const english = String(item?.name_en || "").trim();
  return String(locale || "").toLowerCase().startsWith("zh")
    ? chinese || english
    : english || chinese;
}

function isValidWear(value) {
  const wear = Number(value);
  return Number.isFinite(wear) && wear >= 0 && wear <= 1;
}

function isValidSeed(value) {
  if (value === "" || value === null || value === undefined) return true;
  const seed = Number(value);
  return Number.isInteger(seed);
}

function parseSeed(value) {
  if (value === "" || value === null || value === undefined) return null;
  const seed = Number(value);
  return Number.isInteger(seed) ? seed : null;
}

function TileImage({ item, onlineAssetsEnabled, className = "" }) {
  const [failed, setFailed] = useState(false);
  const src = onlineAssetsEnabled && !failed ? String(item?.image_url || "") : "";

  useEffect(() => setFailed(false), [item?.image_url, onlineAssetsEnabled]);

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
      alt={displayName(item, "zh")}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`h-full w-full object-contain p-2 ${className}`}
    />
  );
}

function SkinTile({ item, locale, onlineAssetsEnabled, label }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-cs2-text-muted">{label}</span>
      <div
        data-skin-tile
        className="flex w-[256px] h-[192px] items-center justify-center overflow-hidden rounded border border-cs2-border bg-cs2-bg-input"
      >
        <TileImage item={item} onlineAssetsEnabled={onlineAssetsEnabled} />
      </div>
      {item ? (
        <span className="max-w-[256px] truncate text-sm text-cs2-text-primary">
          {displayName(item, locale)}
        </span>
      ) : (
        <span className="max-w-[256px] text-sm text-cs2-text-muted">—</span>
      )}
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

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(null);
    setWear(sourceItem?.paint_wear ?? "");
    setSeed(sourceItem?.paint_seed ?? "");
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
      maxWidth="max-w-5xl"
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
      <div className="flex gap-6 p-5">
        <div className="flex shrink-0 flex-col gap-5">
          <SkinTile
            item={sourceItem}
            locale={locale}
            onlineAssetsEnabled={onlineAssetsEnabled}
            label={t("analysis.cosmetics.picker.current")}
          />
          <SkinTile
            item={replacementPreview}
            locale={locale}
            onlineAssetsEnabled={onlineAssetsEnabled}
            label={t("analysis.cosmetics.picker.replacement")}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("analysis.cosmetics.picker.search")}
            className="w-full rounded border border-cs2-border bg-cs2-bg-input px-3 py-2 text-sm text-cs2-text-primary outline-none focus:border-cs2-accent"
          />

          <div className="min-h-0 flex-1">
            <div className="mb-2 text-xs font-medium text-cs2-text-muted">
              {t("analysis.cosmetics.picker.candidates")}
            </div>
            <div
              data-testid="skin-candidate-list"
              className="grid max-h-[360px] grid-cols-2 gap-3 overflow-y-auto pr-1"
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
                    className={`rounded border p-1 text-left transition-colors ${
                      active
                        ? "border-cs2-accent bg-cs2-bg-hover"
                        : "border-cs2-border bg-cs2-bg-input hover:border-cs2-text-muted"
                    }`}
                  >
                    <div
                      data-skin-tile
                      className="flex w-[256px] h-[192px] items-center justify-center overflow-hidden"
                    >
                      <TileImage item={candidate} onlineAssetsEnabled={onlineAssetsEnabled} />
                    </div>
                    <span className="mt-1 block truncate px-1 text-xs text-cs2-text-primary">
                      {displayName(candidate, locale)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-cs2-text-muted">{t("analysis.cosmetics.picker.wear")}</span>
              <input
                type="text"
                inputMode="decimal"
                value={wear}
                onChange={(event) => setWear(event.target.value)}
                className="rounded border border-cs2-border bg-cs2-bg-input px-3 py-2 text-cs2-text-primary outline-none focus:border-cs2-accent"
              />
              {!wearValid ? (
                <span className="text-xs text-red-400">{t("analysis.cosmetics.picker.wearInvalid")}</span>
              ) : null}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-cs2-text-muted">{t("analysis.cosmetics.picker.seed")}</span>
              <input
                type="text"
                inputMode="numeric"
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
                className="rounded border border-cs2-border bg-cs2-bg-input px-3 py-2 text-cs2-text-primary outline-none focus:border-cs2-accent"
              />
              {!seedValid ? (
                <span className="text-xs text-red-400">{t("analysis.cosmetics.picker.seedInvalid")}</span>
              ) : null}
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}
