import { useState } from "react";
import { Gamepad2, Rotate3D } from "lucide-react";
import Modal from "../../components/ui/Modal.jsx";
import Button from "../../components/ui/Button.jsx";
import { useT } from "../../i18n/useT.js";
import { LucasParameter } from "./LucasWorkshop.jsx";
import { craftNameParts } from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

/** Free's editor changes only the existing paint wear and pattern fields. */
export default function LucasItemEditorModal({
  item, locale = "zh", wear, seed, onItemChange, onWearChange, onSeedChange,
  onClose, onConfirm, confirmLabel, preview, inspectBusy, inspectFeedback,
  onInspectInGame, onInspect3d, onlineAssetsEnabled = true, saveError = "",
}) {
  const t = useT();
  const [initial] = useState(() => ({ item, wear, seed }));
  const { model, finish, alt } = craftNameParts(item, locale);
  const min = Number(item?.wear_min ?? 0), max = Number(item?.wear_max ?? 1);
  const validWear = String(wear).trim() !== "" && Number.isFinite(Number(wear))
    && Math.fround(Number(wear)) >= Math.fround(min) && Math.fround(Number(wear)) <= Math.fround(max);
  const validSeed = String(seed).trim() !== "" && Number.isInteger(Number(seed)) && Number(seed) >= 0 && Number(seed) <= 1000;
  const valid = validWear && validSeed;
  const can3d = onlineAssetsEnabled && ["weapon", "melee"].includes(item?.type) && Boolean(onInspect3d);
  return <Modal open={Boolean(item)} onClose={onClose} title={t("cosmeticsWorkshop.editor.title")}
    maxWidth="max-w-[640px]" maxHeight="max-h-[90vh]" fillHeight={false} zIndex={115}
    contentClassName="min-h-0 flex-1 overflow-y-auto"
    footer={<div>{saveError ? <p role="alert" className="mb-3 text-sm text-cs2-text-error">{saveError}</p> : null}
      <div className="flex justify-center gap-2"><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={!valid} onClick={onConfirm}>{confirmLabel}</Button></div></div>}>
    <div className="lucas-craft-layout lucas-craft-two" data-testid="cosmetic-item-editor">
      <div className="lucas-craft-preview" data-testid="cosmetic-editor-preview">
        <div className="lucas-craft-image">{preview}</div>
        <div className="lucas-craft-caption"><p className="lucas-craft-title">{model}</p>
          {finish ? <p className="lucas-craft-finish" style={{ color: item.rarity || "#ddd" }}>{finish}</p> : null}
          {alt ? <p className="text-xs text-cs2-text-muted">{alt}</p> : null}</div>
        <div className="mt-2 flex flex-wrap justify-center gap-2" data-testid="skin-picker-inspect-actions">
          <Button variant="secondary" size="sm" disabled={!valid || !can3d} onClick={onInspect3d}><Rotate3D size={14} />{t("analysis.cosmetics.inspect3d")}</Button>
          <Button variant="secondary" size="sm" disabled={!valid || inspectBusy || !onInspectInGame} onClick={onInspectInGame}><Gamepad2 size={14} />{t("analysis.cosmetics.inspectInGame")}</Button>
        </div>
        {inspectFeedback ? <p role={inspectFeedback.tone === "error" ? "alert" : "status"} className="mt-2 text-xs text-cs2-text-secondary">{inspectFeedback.text}</p> : null}
      </div>
      <div className="lucas-craft-fields">
        <div className="lucas-craft-reset"><Button variant="secondary" size="sm" onClick={() => {
          onItemChange(initial.item); onWearChange(initial.wear); onSeedChange(initial.seed);
        }}>{t("cosmeticsWorkshop.editor.resetChanges")}</Button></div>
        <LucasParameter label={t("cosmeticsWorkshop.scheme.patternSeed")} value={seed} onChange={onSeedChange}
          min={0} max={1000} step={1} error={validSeed ? "" : t("analysis.cosmetics.picker.seedInvalid")} randomLabel={t("analysis.cosmetics.picker.random")} />
        <LucasParameter label={t("analysis.cosmetics.picker.wear")} value={wear} onChange={onWearChange}
          min={min} max={max} step={0.000001} error={validWear ? "" : t("analysis.cosmetics.picker.wearInvalid", { min: min.toFixed(6), max: max.toFixed(6) })}
          randomLabel={t("analysis.cosmetics.picker.random")} />
      </div>
    </div>
  </Modal>;
}
