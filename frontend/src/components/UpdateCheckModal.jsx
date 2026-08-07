import { useT } from "../i18n/useT.js";
import { normalizeUpdateMode } from "../utils/desktopUpdater";

/** Cloudflare / Tauri updater 检查更新弹窗 */
export default function UpdateCheckModal({ open, info, onClose, onCancel, onConfirm, title }) {
  const t = useT();
  if (!open || !info) return null;

  const status = String(info.status || "");
  const err = info.error ? String(info.error) : "";
  const latest = info.latest_version ? String(info.latest_version) : "";
  const current = info.current_version ? String(info.current_version) : "";
  const notes = String(info.release_notes || "").trim();
  const updateMode = normalizeUpdateMode(info.update_mode);
  const isForce = updateMode === "force";
  const percent = Number(info.progress?.percent);
  const hasPercent = Number.isFinite(percent);
  const upToDate = status === "not-available";
  const isAvailable = status === "available";
  const isDownloading = status === "downloading" || status === "downloaded";
  const forceLocked = isForce && (isAvailable || isDownloading);

  let body = null;
  if (err || status === "error") {
    body = <p className="text-[12px] text-cs2-text-error">{err || t("app.updateConnectFail")}</p>;
  } else if (status === "checking") {
    body = <p className="text-sm text-cs2-text-secondary">{t("settings.updateChecking")}</p>;
  } else if (upToDate) {
    body = <p className="text-sm text-cs2-text-secondary">{t("dialog.updateUpToDate")}</p>;
  } else if (isAvailable) {
    body = (
      <div className="space-y-2">
        {isForce ? (
          <p className="text-sm font-semibold text-cs2-orange">{t("dialog.updateForceRequired")}</p>
        ) : (
          <p className="text-sm text-cs2-text-secondary">{t("dialog.updateAvailablePrompt")}</p>
        )}
      </div>
    );
  } else if (status === "downloading") {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-cs2-text-secondary">
          {t("dialog.updateDownloading")}
          {hasPercent ? ` ${Math.round(percent)}%` : ""}
        </p>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-cs2-bg-active">
          <div
            className="h-full bg-cs2-orange transition-all duration-300"
            style={{ width: `${Math.max(0, Math.min(100, hasPercent ? percent : 0))}%` }}
          />
        </div>
      </div>
    );
  } else if (status === "downloaded") {
    body = <p className="text-sm text-cs2-text-secondary">{t("dialog.updateDownloaded")}</p>;
  } else if (status === "cancelled") {
    body = <p className="text-sm text-cs2-text-secondary">{t("dialog.updateCancelled")}</p>;
  }

  const showNotes =
    !err &&
    status !== "error" &&
    status !== "cancelled" &&
    status !== "checking" &&
    status !== "not-available" &&
    notes;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-cs2-bg-overlay p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (forceLocked) e.stopPropagation();
      }}
    >
      <div className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-[var(--cs2-shadow-lg)]">
        <div className="border-b border-cs2-border-subtle px-4 py-3">
          <h2 className="text-sm font-bold text-cs2-text-primary">{title || t("dialog.updateTitle")}</h2>
          {latest || current ? (
            <p className="mt-1 font-mono text-[11px] text-cs2-text-secondary">
              {latest ? (
                <>
                  {t("dialog.updateLatestVersion")} <span className="text-cs2-orange">{latest}</span>
                </>
              ) : null}
              {latest && current ? " · " : null}
              {current ? (
                <>
                  {t("dialog.updateCurrentVersion")} <span className="text-cs2-text-primary">{current}</span>
                </>
              ) : null}
            </p>
          ) : null}
          <p className="mt-1 text-[10px] text-cs2-text-muted">{t("dialog.updateViaCloudflare")}</p>
        </div>
        <div className="max-h-[45vh] overflow-y-auto px-4 py-3">
          {body}
          {showNotes ? (
            <pre className="mt-3 whitespace-pre-wrap break-words rounded-md border border-cs2-border-subtle bg-cs2-bg-input p-3 font-sans text-[12px] leading-relaxed text-cs2-text-secondary">
              {notes}
            </pre>
          ) : null}
          {isAvailable && !notes ? (
            <p className="mt-2 text-[12px] text-cs2-text-muted">{t("dialog.updateNoNotes")}</p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-cs2-border-subtle px-4 py-2">
          {isAvailable ? (
            <>
              {!isForce ? (
                <button
                  type="button"
                  className="text-[11px] font-semibold text-cs2-text-muted hover:text-cs2-text-primary"
                  onClick={() => onClose?.()}
                >
                  {t("dialog.updateLater")}
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-md bg-cs2-orange px-3 py-1.5 text-[11px] font-semibold text-cs2-text-on-accent hover:bg-cs2-accent-light"
                onClick={() => onConfirm?.()}
              >
                {t("dialog.updateNow")}
              </button>
            </>
          ) : null}
          {!isForce && status === "downloading" ? (
            <button
              type="button"
              className="text-[11px] font-semibold text-cs2-orange hover:opacity-90"
              onClick={() => onCancel?.()}
              title={t("dialog.updateStopHint")}
            >
              {t("dialog.updateStop")}
            </button>
          ) : null}
          {!forceLocked && !isAvailable ? (
            <button
              type="button"
              className="text-[11px] font-semibold text-cs2-text-muted hover:text-cs2-text-primary"
              onClick={() => onClose?.()}
            >
              {t("dialog.updateClose")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
