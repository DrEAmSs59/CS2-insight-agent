import { AlertTriangle, Crosshair, Eye, ListOrdered, Loader2, Mic2, Play, RefreshCw, ShieldAlert, Users } from "lucide-react";

import { useT } from "../i18n/useT.js";
import Modal from "./ui/Modal.jsx";

export default function DemoPlayOptionsModal({
  open,
  demoLabel,
  checking = false,
  blockedReason = "",
  error = "",
  launchingMode = "",
  onClose,
  onRetry,
  onPlayAdvanced,
}) {
  const t = useT();
  const launching = !!launchingMode;
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
      title={t("playDemo.title")}
      subtitle={demoLabel || t("playDemo.demoFallback")}
      icon={<Eye className="h-4 w-4 text-cs2-accent" />}
      maxWidth="max-w-2xl"
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
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-bold text-cs2-text-primary">{t("playDemo.previewTitle")}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-cs2-text-muted">{t("playDemo.previewHint")}</p>
                </div>
                <span className="shrink-0 rounded border border-cs2-accent/35 bg-cs2-accent/10 px-2 py-1 text-[10px] font-bold text-cs2-accent">
                  {t("playDemo.povTitle")}
                </span>
              </div>

              <div className="relative min-h-[286px] overflow-hidden rounded-xl border border-cs2-border bg-[radial-gradient(circle_at_72%_28%,rgba(73,153,190,0.22),transparent_32%),linear-gradient(145deg,#2d3438_0%,#171b1c_48%,#101212_100%)] p-3 shadow-inner">
                <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.035)_1px,transparent_1px)] [background-size:28px_28px]" />
                <div className="relative w-full rounded-lg border border-white/15 bg-[#191918f5] p-3 shadow-2xl">
                  <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
                    <span className="text-[12px] font-black tracking-wide text-[#e88713]">INSIGHT · {t("playDemo.previewMenuTitle")}</span>
                    <span className="text-[9px] text-white/35">tick 123516&nbsp;&nbsp; ×</span>
                  </div>

                  <PreviewRow icon={Crosshair} label={t("playDemo.previewHud")}>
                    <PreviewChip active>POV HUD</PreviewChip>
                    <PreviewChip>DEMO HUD</PreviewChip>
                  </PreviewRow>
                  <PreviewRow icon={Mic2} label={t("playDemo.previewVoice")}>
                    <PreviewChip active>{t("playDemo.previewVoiceTeam")}</PreviewChip>
                    <PreviewChip>{t("playDemo.previewVoiceAll")}</PreviewChip>
                    <PreviewChip>{t("playDemo.previewVoiceMute")}</PreviewChip>
                  </PreviewRow>
                  <PreviewRow icon={ListOrdered} label={t("playDemo.previewRounds")}>
                    <PreviewChip active>{t("playDemo.previewRoundCurrent")}</PreviewChip>
                    <PreviewChip>{t("playDemo.previewRoundPicker")}</PreviewChip>
                  </PreviewRow>
                  <PreviewRow icon={Users} label={t("playDemo.previewTeams")} stacked>
                    <div className="grid w-full grid-cols-2 gap-1.5">
                      <PreviewTeam title="CT" tone="text-sky-300" names={["Player 1", "Player 2"]} />
                      <PreviewTeam title="T" tone="text-amber-300" names={["Player 6", "Player 7"]} />
                    </div>
                  </PreviewRow>
                  <PreviewRow icon={Play} label={t("playDemo.previewEvents")} stacked>
                    <div className="flex w-full gap-1">
                      {[t("playDemo.previewEventAll"), t("playDemo.previewEventKills"), t("playDemo.previewEventDeaths"), t("playDemo.previewEventUtility")].map((label, index) => (
                        <PreviewChip key={label} active={index === 0}>{label}</PreviewChip>
                      ))}
                    </div>
                    <div className="mt-1.5 flex w-full items-center rounded border border-white/10 bg-black/15 px-2 py-1.5 text-[8px]">
                      <span className="w-12 shrink-0 text-white/30">R2 · 2:24</span>
                      <span className="min-w-0 flex-1 truncate text-right text-sky-300">Player 1</span>
                      <img className="mx-1 h-3 w-8 object-contain brightness-0 invert" src="/hud-death-notice/ak47.svg" alt="AK-47" />
                      <img className="h-3 w-3 object-contain brightness-0 invert" src="/hud-death-notice/throughsmoke.svg" alt={t("playDemo.previewThroughSmoke")} />
                      <img className="mx-1 h-3 w-3 object-contain brightness-0 invert" src="/hud-death-notice/headshot.svg" alt={t("playDemo.previewHeadshot")} />
                      <span className="min-w-0 flex-1 truncate text-left text-amber-300">Player 6</span>
                    </div>
                  </PreviewRow>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-cs2-rose-surface px-3 py-2.5 text-[11px] leading-relaxed text-cs2-text-muted">
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

function PreviewChip({ active = false, children }) {
  return (
    <span className={`min-w-0 flex-1 rounded border px-1.5 py-1 text-center text-[8px] font-bold ${active ? "border-[#e88713] bg-[#e88713] text-black" : "border-white/15 bg-white/[0.035] text-white/65"}`}>
      {children}
    </span>
  );
}

function PreviewRow({ icon: Icon, label, stacked = false, children }) {
  return (
    <div className={`mb-1.5 flex gap-2 rounded border border-white/[0.07] bg-black/15 p-1.5 ${stacked ? "items-start" : "items-center"}`}>
      <div className="flex w-[54px] shrink-0 items-center gap-1 text-[9px] font-bold text-white/55">
        <Icon className="h-3 w-3 text-[#e88713]" />
        {label}
      </div>
      <div className={stacked ? "min-w-0 flex-1" : "flex min-w-0 flex-1 gap-1"}>{children}</div>
    </div>
  );
}

function PreviewTeam({ title, tone, names }) {
  return (
    <div className="rounded border border-white/10 bg-black/15 p-1">
      <p className={`mb-1 text-center text-[8px] font-black ${tone}`}>{title}</p>
      {names.map((name) => <p key={name} className="mb-0.5 truncate rounded bg-white/[0.04] px-1 py-0.5 text-[8px] text-white/55">{name}</p>)}
    </div>
  );
}
