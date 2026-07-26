import { AlertTriangle, CheckCircle2, FileCheck2, Loader2, RefreshCw, XCircle } from "lucide-react";

import { useT } from "../i18n/useT.js";
import Modal from "./ui/Modal.jsx";

function FactRow({ label, value, successText, failureText, unknownText }) {
  const known = typeof value === "boolean";
  const Icon = !known ? AlertTriangle : value ? CheckCircle2 : XCircle;
  const tone = !known ? "text-cs2-amber-on-surface" : value ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="flex items-start gap-2 rounded-lg border border-cs2-border bg-cs2-bg-input/40 px-3 py-2.5">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <div className="min-w-0">
        <p className="text-xs font-bold text-cs2-text-primary">{label}</p>
        <p className={`mt-0.5 text-[11px] leading-relaxed ${tone}`}>
          {!known ? unknownText : value ? successText : failureText}
        </p>
      </div>
    </div>
  );
}

export default function DemoPlaybackRestoreModal({
  open,
  status,
  pollError = "",
  onClose,
  onRetry,
}) {
  const t = useT();
  const state = String(status?.state || "running");
  const restore = status?.restore && typeof status.restore === "object" ? status.restore : null;
  const final = state === "completed" || state === "restore_failed";
  const verified = Boolean(final && restore?.verified);
  const failed = final && !verified;
  const canClose = final || Boolean(pollError);

  return (
    <Modal
      open={open}
      onClose={() => {
        if (canClose) onClose?.();
      }}
      title={t("playDemo.restoreTitle")}
      subtitle={t("playDemo.restoreSubtitle")}
      icon={verified
        ? <FileCheck2 className="h-4 w-4 text-emerald-400" />
        : failed
          ? <AlertTriangle className="h-4 w-4 text-rose-400" />
          : <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />}
      maxWidth="max-w-lg"
      maxHeight="max-h-[82vh]"
      zIndex={155}
    >
      <div className="space-y-4 px-5 py-5">
        {!final ? (
          <div className="flex items-start gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input/35 px-4 py-3">
            <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-cs2-accent" />
            <div>
              <p className="text-sm font-bold text-cs2-text-primary">
                {state === "restoring" ? t("playDemo.restoreChecking") : t("playDemo.restoreWaiting")}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">{t("playDemo.restoreDoNotAssume")}</p>
            </div>
          </div>
        ) : (
          <div className={`rounded-lg border px-4 py-3 ${verified ? "border-emerald-500/35 bg-emerald-500/10" : "border-rose-500/35 bg-cs2-rose-surface"}`}>
            <p className={`text-sm font-bold ${verified ? "text-emerald-400" : "text-cs2-rose-on-surface"}`}>
              {verified ? t("playDemo.restoreVerifiedTitle") : t("playDemo.restoreFailedTitle")}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">
              {verified ? t("playDemo.restoreVerifiedDesc") : t("playDemo.restoreFailedDesc")}
            </p>
          </div>
        )}

        {restore ? (
          <div className="space-y-2">
            <FactRow
              label="gameinfo.gi"
              value={restore.gameinfo_restored}
              successText={t("playDemo.gameinfoRestored")}
              failureText={t("playDemo.gameinfoNotRestored")}
              unknownText={t("playDemo.restoreUnknown")}
            />
            <FactRow
              label="pov.vpk"
              value={restore.pov_vpk_removed}
              successText={t("playDemo.vpkRemoved")}
              failureText={t("playDemo.vpkStillPresent")}
              unknownText={t("playDemo.restoreUnknown")}
            />
            {restore.expected_gameinfo_sha256 || restore.actual_gameinfo_sha256 ? (
              <div className="rounded-lg border border-cs2-border bg-cs2-bg-card px-3 py-2 text-[10px] text-cs2-text-muted">
                <p className="break-all">{t("playDemo.expectedHash")}: {restore.expected_gameinfo_sha256 || "—"}</p>
                <p className="mt-1 break-all">{t("playDemo.actualHash")}: {restore.actual_gameinfo_sha256 || "—"}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {pollError ? (
          <div className="rounded-lg border border-amber-500/35 bg-cs2-amber-surface px-3 py-2.5 text-[11px] text-cs2-amber-on-surface">
            {t("playDemo.restoreStatusUnavailable")}: {pollError}
          </div>
        ) : null}
        {restore?.error ? (
          <div className="rounded-lg border border-rose-500/35 bg-cs2-rose-surface px-3 py-2.5 text-[11px] text-cs2-rose-on-surface">
            {restore.error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {(failed || pollError) ? (
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1.5 rounded-lg border border-cs2-border px-3 py-2 text-xs font-semibold text-cs2-text-secondary hover:bg-cs2-bg-hover"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("playDemo.restoreRecheck")}
            </button>
          ) : null}
          {canClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-cs2-accent px-3 py-2 text-xs font-bold text-cs2-text-on-accent hover:bg-cs2-accent-light"
            >
              {t("common.close")}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
