import { CopyCheck, Layers, RotateCcw } from "lucide-react";
import { useT } from "../../../i18n/useT.js";
import { FILTER_PRESETS } from "./editorPresets.js";
import { PaneSection, ProSlider, ScopeActionButton } from "./PropertyControls.jsx";
import { VISUAL_COLOR_DEFAULT, VISUAL_COLOR_MAX, VISUAL_COLOR_MIN } from "../domain/visualMaterial.js";

export default function ColorPropertyPane({
  brightness,
  contrast,
  saturation,
  onColorChange,
  filterPreset,
  onFilterPresetChange,
  onApplyColorScope,
  canApplyColorTrack = false,
  canApplyColorAll = false,
}) {
  const t = useT();
  return <>
    <PaneSection title={t("liteCut.color.filters")}>
      <div className="grid grid-cols-4 gap-2">
        {FILTER_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => onFilterPresetChange?.(preset.id)} className={`overflow-hidden rounded-lg border ${filterPreset === preset.id ? "border-cs2-accent ring-2 ring-cs2-accent/25" : "border-cs2-border/50"}`}>
          <div className="aspect-square" style={{ backgroundImage: preset.thumbnailBackground, filter: preset.filter === "none" ? undefined : preset.filter }} />
          <p className="truncate px-1 py-1 text-center text-[9px] font-semibold text-cs2-text-secondary">{t(`liteCut.color.preset.${preset.id}`)}</p>
        </button>)}
      </div>
    </PaneSection>
    <PaneSection title={t("liteCut.color.adjust")}>
      <button type="button" onClick={() => onColorChange?.({ brightness: VISUAL_COLOR_DEFAULT, contrast: VISUAL_COLOR_DEFAULT, saturation: VISUAL_COLOR_DEFAULT })} className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-cs2-accent"><RotateCcw className="h-3 w-3" /> {t("liteCut.color.resetAll")}</button>
      <ProSlider label={t("liteCut.color.brightness")} value={brightness} onChange={(value) => onColorChange?.({ brightness: value })} min={VISUAL_COLOR_MIN} max={VISUAL_COLOR_MAX} resetValue={VISUAL_COLOR_DEFAULT} />
      <ProSlider label={t("liteCut.color.contrast")} value={contrast} onChange={(value) => onColorChange?.({ contrast: value })} min={VISUAL_COLOR_MIN} max={VISUAL_COLOR_MAX} resetValue={VISUAL_COLOR_DEFAULT} />
      <ProSlider label={t("liteCut.color.saturation")} value={saturation} onChange={(value) => onColorChange?.({ saturation: value })} min={VISUAL_COLOR_MIN} max={VISUAL_COLOR_MAX} resetValue={VISUAL_COLOR_DEFAULT} />
      <div className="grid grid-cols-2 gap-2 pt-1">
        <ScopeActionButton icon={CopyCheck} disabled={!canApplyColorTrack} onClick={() => onApplyColorScope?.("track")}>{t("liteCut.color.applyTrack")}</ScopeActionButton>
        <ScopeActionButton icon={Layers} disabled={!canApplyColorAll} onClick={() => onApplyColorScope?.("all")}>{t("liteCut.color.applyAll")}</ScopeActionButton>
      </div>
    </PaneSection>
  </>;
}
