import { AlertTriangle, ChevronLeft, ChevronRight, Cloud, Crosshair, Eye, Loader2, Package, Play, RefreshCw, ShieldAlert, Skull, Volume2, X } from "lucide-react";

import { useT } from "../i18n/useT.js";
import {
  DEFAULT_RECORDING_SKYBOX,
  isCustomRecordingSkyboxId,
  normalizeRecordingSkyboxId,
  partitionBuiltinRecordingSkyboxes,
  recordingSkyboxDisplayName,
  recordingSkyboxPreviewUrl,
  RECORDING_SKYBOX_OPTIONS,
  sortBuiltinRecordingSkyboxes,
} from "../utils/recordingSkybox.js";
import {
  DEFAULT_RECORDING_MAP_MATERIAL,
  normalizeRecordingMapMaterialId,
  WAXED_REFLECTION_MAP_MATERIAL,
} from "../utils/recordingMapMaterial.js";
import Modal from "./ui/Modal.jsx";

export default function DemoPlayOptionsModal({
  open,
  demoLabel,
  checking = false,
  blockedReason = "",
  error = "",
  launchingMode = "",
  recordingSkybox = DEFAULT_RECORDING_SKYBOX,
  recordingMapMaterial = DEFAULT_RECORDING_MAP_MATERIAL,
  skyboxResources = [],
  onClose,
  onRetry,
  onPlayAdvanced,
  onRecordingSkyboxChange,
  onRecordingMapMaterialChange,
}) {
  const t = useT();
  const launching = !!launchingMode;
  const selectedSkybox = normalizeRecordingSkyboxId(recordingSkybox);
  const selectedMapMaterial = normalizeRecordingMapMaterialId(recordingMapMaterial);
  const catalogBuiltinSkyboxes = sortBuiltinRecordingSkyboxes(
    Array.isArray(skyboxResources)
      ? skyboxResources.filter((item) => item?.source === "builtin" && item?.available)
      : [],
  );
  const builtinSkyboxes = catalogBuiltinSkyboxes.length
    ? catalogBuiltinSkyboxes
    : RECORDING_SKYBOX_OPTIONS.slice(1).map((option) => ({ id: option.value }));
  const {
    solidColor: solidColorSkyboxes,
    standard: standardBuiltinSkyboxes,
  } = partitionBuiltinRecordingSkyboxes(builtinSkyboxes);
  const customSkyboxes = Array.isArray(skyboxResources)
    ? skyboxResources.filter((item) => item?.source === "custom" && item?.available)
    : [];
  const selectedCustomAvailable = customSkyboxes.some((item) => item.id === selectedSkybox);
  const selectedSkyboxPreview = recordingSkyboxPreviewUrl(selectedSkybox, skyboxResources);
  const blockedMessage = blockedReason === "path"
    ? t("playDemo.cs2PathMissing")
    : blockedReason === "busy"
      ? t("playDemo.busyMessage")
      : t("playDemo.cs2RunningMessage");

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!launching) onClose?.();
      }}
      closable={!launching}
      title={t("playDemo.title")}
      subtitle={demoLabel || t("playDemo.demoFallback")}
      icon={<Eye className="h-4 w-4 text-cs2-accent" />}
      maxWidth={launching ? "max-w-lg" : "max-w-4xl"}
      maxHeight="max-h-[90vh]"
      className="!h-auto"
      contentClassName="overflow-y-auto"
      zIndex={150}
    >
      <div className="space-y-3 px-5 py-4">
        {checking ? (
          <div className="flex min-h-36 flex-col items-center justify-center gap-3 text-cs2-text-muted">
            <Loader2 className="h-6 w-6 animate-spin text-cs2-accent" />
            <p className="text-sm">{t("playDemo.checking")}</p>
          </div>
        ) : launching ? (
          <div
            className="flex min-h-28 flex-col items-center justify-center gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input/35 px-4 py-5 text-center"
            role="status"
            aria-live="polite"
            data-testid="demo-play-preparing"
          >
            <Loader2 className="h-8 w-8 animate-spin text-cs2-accent" aria-hidden />
            <p className="text-sm font-semibold text-cs2-text-primary">
              {t("common.preparingMapResources")}
            </p>
          </div>
        ) : blockedReason ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-500/35 bg-cs2-amber-surface px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-cs2-amber-on-surface" />
                <div>
                  <p className="text-sm font-bold text-cs2-amber-on-surface">{t("playDemo.blockedTitle")}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-secondary">{blockedMessage}</p>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-cs2-border px-3 py-2 text-xs font-semibold text-cs2-text-secondary hover:bg-cs2-bg-hover"
              >
                {t("common.cancel")}
              </button>
              {blockedReason !== "path" ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex items-center gap-1.5 rounded-lg bg-cs2-accent px-3 py-2 text-xs font-bold text-cs2-text-on-accent hover:bg-cs2-accent-light"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("playDemo.retryCheck")}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <div data-testid="demo-play-preview">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-bold text-cs2-text-primary">{t("playDemo.previewTitle")}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-cs2-text-muted">{t("playDemo.previewHint")}</p>
                </div>
                <span className="shrink-0 rounded border border-cs2-accent/35 bg-cs2-accent/10 px-2 py-1 text-[10px] font-bold text-cs2-accent">
                  {t("playDemo.povTitle")}
                </span>
              </div>

              <div className="relative min-h-[390px] overflow-hidden rounded-xl border border-cs2-border bg-[radial-gradient(circle_at_52%_28%,rgba(183,209,213,0.34),transparent_28%),linear-gradient(160deg,#85989c_0%,#536668_31%,#293435_61%,#161b1c_100%)] p-3 shadow-inner sm:p-4">
                <div className="pointer-events-none absolute inset-x-0 bottom-[52px] top-[38%] opacity-65">
                  <div className="absolute bottom-0 left-[2%] h-[68%] w-[38%] border border-white/10 bg-[#6f7774] shadow-[inset_0_0_36px_rgba(0,0,0,.34)]" />
                  <div className="absolute bottom-0 left-[30%] h-[86%] w-[28%] border border-white/10 bg-[#596360]" />
                  <div className="absolute bottom-0 right-[3%] h-[56%] w-[35%] border border-white/10 bg-[#707975]" />
                  <div className="absolute bottom-[22%] left-0 h-[9%] w-full bg-[#9d9c8f]/65" />
                </div>
                <div className="pointer-events-none absolute left-4 top-4 h-[96px] w-[96px] rounded-full border border-sky-300/60 bg-[#7f8985]/75 shadow-[0_0_28px_rgba(0,0,0,.28)]">
                  <div className="absolute left-[28%] top-[24%] h-[46%] w-[42%] rotate-[-18deg] border-[7px] border-[#d8d5c7]/65" />
                  <span className="absolute bottom-4 left-4 text-[8px] font-black text-amber-300">B</span>
                  <span className="absolute right-5 top-8 text-[8px] font-black text-sky-300">A</span>
                </div>
                <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1 rounded border border-white/10 bg-black/35 px-2 py-1 text-[8px] font-black text-white/65">
                  <span className="text-sky-300">5</span><span className="text-red-400">0:04</span><span className="text-amber-300">5</span>
                </div>
                <div className="pointer-events-none absolute bottom-[58px] left-5 text-[17px] font-black text-sky-200/80">$150</div>
                <div className="pointer-events-none absolute bottom-[58px] left-[42%] text-[15px] font-black text-sky-100/80">100</div>
                <div className="pointer-events-none absolute bottom-[58px] right-7 text-right text-[12px] font-black text-sky-100/80">12&nbsp;&nbsp; 2<br /><span className="text-[8px]">USP</span></div>

                <div className="relative z-10 flex min-h-[354px] items-center justify-end">
                  <div data-testid="advanced-playback-hud-preview" className="w-full rounded-[9px] border border-[#4b4a46] bg-[#191918f7] p-2.5 shadow-[0_12px_34px_rgba(0,0,0,.58)] sm:w-[62%] lg:w-[55%]">
                    <div className="mb-1.5 flex h-8 items-center gap-2">
                      <div className="min-w-0 flex-1 text-[9px] font-black leading-[10px] text-[#e88713]">
                        INSIGHT AGENT<br />{t("playDemo.previewMenuTitle")}
                      </div>
                      <span className="hidden text-[7px] text-white/35 md:inline">{t("playDemo.previewEdgeHint")}</span>
                      <PreviewControl active className="!min-w-[64px] !flex-none">{t("playDemo.previewTitleBarOn")}</PreviewControl>
                      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded border border-white/15 bg-white/[0.035] text-white/80"><X className="h-3 w-3" /></span>
                    </div>

                    <PreviewHudRow label={t("playDemo.previewHud")}>
                      <PreviewControl active>POV HUD</PreviewControl>
                      <PreviewControl>DEMO HUD</PreviewControl>
                      <PreviewControl>{t("playDemo.previewHudHidden")}</PreviewControl>
                    </PreviewHudRow>
                    <PreviewHudRow label={t("playDemo.previewVoice")}>
                      <PreviewControl active>{t("playDemo.previewVoiceAll")}</PreviewControl>
                      <PreviewControl>{t("playDemo.previewVoiceOwn")}</PreviewControl>
                      <PreviewControl>{t("playDemo.previewVoiceOpponent")}</PreviewControl>
                      <PreviewControl>{t("playDemo.previewVoiceMute")}</PreviewControl>
                    </PreviewHudRow>
                    <PreviewHudRow label={t("playDemo.previewRounds")}>
                      <PreviewControl>{t("playDemo.previewRoundPrevious")}</PreviewControl>
                      <PreviewControl className="flex-[1.35]">{t("playDemo.previewRoundCurrent")}</PreviewControl>
                      <PreviewControl>{t("playDemo.previewRoundNext")}</PreviewControl>
                      <span className="w-[52px] shrink-0 text-center text-[7px] text-white/45">{t("playDemo.previewRoundCount")}</span>
                    </PreviewHudRow>
                    <p className="mb-1.5 pl-[39px] text-[7px] font-semibold text-white/38">{t("playDemo.previewRoundHint")}</p>

                    <div className="mb-1.5 flex items-start gap-1.5">
                      <span className="w-[33px] shrink-0 pt-1 text-[8px] font-bold text-white/50">{t("playDemo.previewTeams")}</span>
                      <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
                        <PreviewTeam title="CT" side="ct" names={["Player 1", "Player 2", "Player 3", "Player 4", "Player 5"]} />
                        <PreviewTeam title="T" side="t" names={["Player 6", "Player 7", "Player 8", "Player 9", "Player 10"]} />
                      </div>
                    </div>

                    <div className="flex items-start gap-1.5">
                      <span className="w-[33px] shrink-0 pt-1 text-[8px] font-bold text-white/50">{t("playDemo.previewEvents")}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex gap-1">
                          <PreviewControl active className="flex-[1.2]">{t("playDemo.previewFollowRound")}</PreviewControl>
                          <PreviewControl active>{t("playDemo.previewEventAll")}</PreviewControl>
                          <PreviewControl ariaLabel={t("playDemo.previewEventKills")}><Crosshair className="h-2.5 w-2.5" />{t("playDemo.previewEventKills")}</PreviewControl>
                          <PreviewControl ariaLabel={t("playDemo.previewEventDeaths")}><Skull className="h-2.5 w-2.5" />{t("playDemo.previewEventDeaths")}</PreviewControl>
                          <PreviewControl ariaLabel={t("playDemo.previewEventUtility")}><Package className="h-2.5 w-2.5" />{t("playDemo.previewEventUtility")}</PreviewControl>
                          <span className="flex h-[22px] w-[20px] shrink-0 items-center justify-center rounded border border-white/10 text-white/45"><ChevronLeft className="h-2.5 w-2.5" /></span>
                          <span className="hidden w-[44px] shrink-0 text-center text-[6px] leading-[9px] text-white/42 lg:block">{t("playDemo.previewEventCount")}</span>
                          <span className="flex h-[22px] w-[20px] shrink-0 items-center justify-center rounded border border-white/10 text-white/45"><ChevronRight className="h-2.5 w-2.5" /></span>
                        </div>
                        <div className="mt-1.5 flex h-[48px] items-start rounded border border-white/10 bg-[#11111088] p-1.5 text-[7px]">
                          <span className="w-10 shrink-0 text-white/32">R2 · 0:14</span>
                          <span className="min-w-0 flex-1 truncate text-right text-sky-300">Player 1</span>
                          <img className="mx-1 h-3 w-7 object-contain brightness-0 invert" src="/hud-death-notice/ak47.svg" alt="AK-47" />
                          <img className="mr-1 h-3 w-3 object-contain brightness-0 invert" src="/hud-death-notice/headshot.svg" alt={t("playDemo.previewHeadshot")} />
                          <span className="min-w-0 flex-1 truncate text-amber-300">Player 6</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex h-[48px] items-center gap-3 border-t border-white/20 bg-[#4b4948d9] px-4 text-[8px] font-semibold text-white/55">
                  <Play className="h-3.5 w-3.5 fill-current text-white/80" />
                  <span>0:14.8 / 38:29</span>
                  <span>-15s</span>
                  <span className="text-[14px]">◷</span>
                  <span>+15s</span>
                  <span className="ml-auto hidden sm:inline">{t("playDemo.previewNativeDemoUi")}</span>
                  <span className="text-[13px]">⚙</span>
                </div>
              </div>
            </div>

            <div
              data-testid="demo-play-map-material-option"
              className="flex items-center gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input/45 px-3 py-2.5"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-cs2-accent/10 text-cs2-accent">
                <Package className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-bold text-cs2-text-primary">{t("playDemo.mapMaterialTitle")}</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-cs2-text-muted">{t("playDemo.mapMaterialHint")}</p>
              </div>
              <select
                aria-label={t("playDemo.mapMaterialSelectLabel")}
                value={selectedMapMaterial}
                disabled={launching || !onRecordingMapMaterialChange}
                onChange={(event) => onRecordingMapMaterialChange?.(event.target.value)}
                className="min-w-44 max-w-[48%] rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-2 text-xs font-semibold text-cs2-text-primary outline-none focus:border-cs2-accent/60 disabled:opacity-50"
              >
                <option value={DEFAULT_RECORDING_MAP_MATERIAL}>{t("record.mapMaterialDefault")}</option>
                <option value={WAXED_REFLECTION_MAP_MATERIAL}>{t("record.mapMaterialWaxedReflection")}</option>
              </select>
            </div>

            <div
              data-testid="demo-play-skybox-option"
              className="flex items-center gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input/45 px-3 py-2.5"
            >
              {selectedSkyboxPreview ? (
                <img
                  data-testid="demo-play-skybox-preview"
                  src={selectedSkyboxPreview}
                  alt={t("settings.skyboxPreviewAlt", {
                    name: recordingSkyboxDisplayName(
                      selectedSkybox,
                      (Array.isArray(skyboxResources)
                        ? skyboxResources.find((item) => item?.id === selectedSkybox)?.display_name
                        : ""),
                      t,
                    ),
                  })}
                  className="aspect-[2/1] w-24 shrink-0 rounded-md border border-cs2-border object-cover"
                />
              ) : (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-cs2-accent/10 text-cs2-accent">
                  <Cloud className="h-4 w-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-bold text-cs2-text-primary">{t("playDemo.skyboxTitle")}</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-cs2-text-muted">{t("playDemo.skyboxHint")}</p>
              </div>
              <select
                aria-label={t("playDemo.skyboxSelectLabel")}
                value={selectedSkybox}
                disabled={launching || !onRecordingSkyboxChange}
                onChange={(event) => onRecordingSkyboxChange?.(event.target.value)}
                className="min-w-44 max-w-[48%] rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-2 text-xs font-semibold text-cs2-text-primary outline-none focus:border-cs2-accent/60 disabled:opacity-50"
              >
                <option value={DEFAULT_RECORDING_SKYBOX}>{t("record.skyboxDefault")}</option>
                <optgroup label={t("record.skyboxSolidColorOptions")}>
                  {solidColorSkyboxes.map((item) => (
                    <option key={item.id} value={item.id}>
                      {recordingSkyboxDisplayName(item.id, item.display_name, t)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t("record.skyboxBuiltinOptions")}>
                  {standardBuiltinSkyboxes.map((item) => (
                    <option key={item.id} value={item.id}>
                      {recordingSkyboxDisplayName(item.id, item.display_name, t)}
                    </option>
                  ))}
                </optgroup>
                {customSkyboxes.length ? (
                  <optgroup label={t("record.skyboxCustomOptions")}>
                    {customSkyboxes.map((item) => (
                      <option key={item.id} value={item.id}>{item.display_name}</option>
                    ))}
                  </optgroup>
                ) : null}
                {isCustomRecordingSkyboxId(selectedSkybox) && !selectedCustomAvailable ? (
                  <option value={selectedSkybox} disabled>{t("record.skyboxMissingCustom")}</option>
                ) : null}
              </select>
            </div>

            <div data-testid="demo-play-gameinfo-warning" className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-cs2-rose-surface px-3 py-2.5 text-[11px] leading-relaxed text-cs2-text-muted">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-cs2-rose-on-surface" />
              <div>
                <p className="font-bold text-cs2-rose-on-surface">{t("playDemo.safetyTitle")}</p>
                <p className="mt-0.5">{t("playDemo.safetyNote")}</p>
              </div>
            </div>

            {error ? (
              <div className="rounded-lg border border-rose-500/35 bg-cs2-rose-surface px-3 py-2.5 text-[12px] text-cs2-rose-on-surface">
                {error}
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={launching}
                onClick={onClose}
                className="rounded-lg border border-cs2-border px-3 py-2 text-xs font-semibold text-cs2-text-secondary hover:bg-cs2-bg-hover disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={launching}
                onClick={onPlayAdvanced}
                data-testid="demo-play-advanced-option"
                className="flex items-center gap-1.5 rounded-lg bg-cs2-accent px-3 py-2 text-xs font-bold text-cs2-text-on-accent hover:bg-cs2-accent-light disabled:opacity-50"
              >
                {launchingMode === "advanced" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                {t("playDemo.launchAdvanced")}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function PreviewControl({ active = false, ariaLabel, className = "", children }) {
  return (
    <span aria-label={ariaLabel} className={`flex h-[22px] min-w-0 flex-1 items-center justify-center gap-0.5 rounded border px-1 text-center text-[7px] font-bold leading-none ${active ? "border-[#e88713] bg-[#e88713] text-white" : "border-white/15 bg-white/[0.025] text-white/62"} ${className}`}>
      {children}
    </span>
  );
}

function PreviewHudRow({ label, children }) {
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <span className="w-[33px] shrink-0 text-[8px] font-bold text-white/50">{label}</span>
      <div className="flex min-w-0 flex-1 gap-1">{children}</div>
    </div>
  );
}

function PreviewTeam({ title, side, names }) {
  const isCt = side === "ct";
  const dotColors = ["bg-sky-300", "bg-emerald-400", "bg-yellow-300", "bg-orange-400", "bg-fuchsia-400"];
  return (
    <div className={`overflow-hidden rounded border ${isCt ? "border-sky-400/35 bg-sky-950/45" : "border-amber-400/35 bg-amber-950/35"}`}>
      <p className={`px-2 py-1 text-left text-[8px] font-black ${isCt ? "bg-sky-400/12 text-sky-300" : "bg-amber-400/12 text-amber-300"}`}>{title}</p>
      <div className="space-y-0.5 p-1">
        {names.map((name, index) => (
          <div data-testid="advanced-preview-player-row" key={name} className={`flex h-[16px] items-center gap-1 rounded border px-1 ${index === 0 && isCt ? "border-[#e88713] bg-[#e88713] text-white" : isCt ? "border-sky-300/15 bg-sky-950/30 text-white/65" : "border-amber-300/15 bg-amber-950/25 text-white/65"}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColors[index]}`} />
            <span className="min-w-0 flex-1 truncate text-center text-[7px] font-semibold">{name}</span>
            <Volume2 className="h-2.5 w-2.5 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
