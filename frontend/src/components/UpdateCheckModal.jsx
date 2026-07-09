import { useT } from "../i18n/useT.js";

/** Cloudflare / electron-updater 检查更新弹窗 */
export default function UpdateCheckModal({ open, info, onClose, onCancel, title }) {
  const t = useT();
  if (!open || !info) return null;

  const status = String(info.status || "");
  const err = info.error ? String(info.error) : "";
  const latest = info.latest_version ? String(info.latest_version) : "";
  const current = info.current_version ? String(info.current_version) : "";
  const notes = String(info.release_notes || "");
  const percent = Number(info.progress?.percent);
  const hasPercent = Number.isFinite(percent);
  const upToDate = status === "not-available";
  const canStop = status === "checking" || status === "available" || status === "downloading";

  let body = null;
  if (err || status === "error") {
    body = <p className="text-[12px] text-red-400">{err || t("app.updateConnectFail")}</p>;
  } else if (status === "checking") {
    body = <p className="text-sm text-zinc-300">{t("settings.updateChecking")}</p>;
  } else if (upToDate) {
    body = <p className="text-sm text-zinc-300">{t("dialog.updateUpToDate")}</p>;
  } else if (status === "available") {
    body = <p className="text-sm text-zinc-300">{t("dialog.updateDownloadingStart")}</p>;
  } else if (status === "downloading") {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-zinc-300">
          {t("dialog.updateDownloading")}
          {hasPercent ? ` ${Math.round(percent)}%` : ""}
        </p>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-cs2-orange transition-all duration-300"
            style={{ width: `${Math.max(0, Math.min(100, hasPercent ? percent : 0))}%` }}
          />
        </div>
      </div>
    );
  } else if (status === "downloaded") {
    body = <p className="text-sm text-zinc-300">{t("dialog.updateDownloaded")}</p>;
  } else if (status === "cancelled") {
    body = <p className="text-sm text-zinc-300">{t("dialog.updateCancelled")}</p>;
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-cs2-bg-card shadow-2xl">
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-bold text-white">{title || t("dialog.updateTitle")}</h2>
          {latest || current ? (
            <p className="mt-1 font-mono text-[11px] text-zinc-400">
              {latest ? (
                <>
                  {t("dialog.updateLatestVersion")} <span className="text-cs2-orange">{latest}</span>
                </>
              ) : null}
              {latest && current ? " · " : null}
              {current ? (
                <>
                  {t("dialog.updateCurrentVersion")} <span className="text-zinc-300">{current}</span>
                </>
              ) : null}
            </p>
          ) : null}
          <p className="mt-1 text-[10px] text-zinc-500">{t("dialog.updateViaCloudflare")}</p>
        </div>
        <div className="max-h-[45vh] overflow-y-auto px-4 py-3">
          {body}
          {!err && status !== "error" && status !== "cancelled" && notes ? (
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-zinc-300">
              {notes}
            </pre>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-white/10 px-4 py-2">
          {canStop ? (
            <button
              type="button"
              className="text-[11px] font-semibold text-cs2-orange hover:opacity-90"
              onClick={() => onCancel?.()}
            >
              {t("dialog.updateStop")}
            </button>
          ) : null}
          <button type="button" className="text-[11px] font-semibold text-zinc-500 hover:text-white" onClick={onClose}>
            {t("dialog.updateClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
