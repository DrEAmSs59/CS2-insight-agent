import { AlertTriangle, Eye, Loader2, Play, RefreshCw, ShieldAlert } from "lucide-react";

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
  onPlayNormal,
  onPlayPov,
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
      icon={<Play className="h-4 w-4 text-cs2-accent" />}
      maxWidth="max-w-lg"
      maxHeight="max-h-[82vh]"
      zIndex={150}
    >
      <div className="space-y-4 px-5 py-5">
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
            <p className="text-[12px] leading-relaxed text-cs2-text-muted">{t("playDemo.chooseMode")}</p>

            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={launching}
                onClick={onPlayNormal}
                className="group rounded-xl border border-cs2-border bg-cs2-bg-input/45 p-4 text-left transition-colors hover:border-cs2-accent/50 hover:bg-cs2-bg-hover disabled:opacity-50"
              >
                <div className="flex items-center gap-2">
                  {launchingMode === "normal" ? <Loader2 className="h-5 w-5 animate-spin text-cs2-accent" /> : <Play className="h-5 w-5 text-cs2-accent" />}
                  <span className="text-sm font-bold text-cs2-text-primary">{t("playDemo.normalTitle")}</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-cs2-text-muted">{t("playDemo.normalDesc")}</p>
              </button>

              <button
                type="button"
                disabled={launching}
                onClick={onPlayPov}
                className="group rounded-xl border border-amber-500/30 bg-cs2-amber-surface p-4 text-left transition-colors hover:border-amber-400/60 disabled:opacity-50"
              >
                <div className="flex items-center gap-2">
                  {launchingMode === "pov" ? <Loader2 className="h-5 w-5 animate-spin text-cs2-amber-on-surface" /> : <Eye className="h-5 w-5 text-cs2-amber-on-surface" />}
                  <span className="text-sm font-bold text-cs2-amber-on-surface">{t("playDemo.povTitle")}</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-cs2-text-secondary">{t("playDemo.povDesc")}</p>
              </button>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-rose-500/25 bg-cs2-rose-surface px-3 py-2.5 text-[11px] leading-relaxed text-cs2-text-muted">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-cs2-rose-on-surface" />
              <span>{t("playDemo.safetyNote")}</span>
            </div>

            {error ? (
              <div className="rounded-lg border border-rose-500/35 bg-cs2-rose-surface px-3 py-2.5 text-[12px] text-cs2-rose-on-surface">
                {error}
              </div>
            ) : null}

            <div className="flex justify-end">
              <button
                type="button"
                disabled={launching}
                onClick={onClose}
                className="rounded-lg border border-cs2-border px-3 py-2 text-xs font-semibold text-cs2-text-secondary hover:bg-cs2-bg-hover disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
