import { useT } from "../i18n/useT.js";

export default function UpdateCheckModal({ open, info, onClose, title, manual }) {
  const t = useT();
  if (!open || !info) return null;
  const notes = String(info.release_notes || "");
  const err = info.error ? String(info.error) : "";
  const upToDate = manual && !info.update_available && !err && info.latest_version;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-cs2-bg-card shadow-2xl">
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-bold text-white">{title || t("dialog.updateTitle")}</h2>
          {info.latest_version ? (
            <p className="mt-1 font-mono text-[11px] text-zinc-400">
              {t("dialog.updateLatestVersion")} <span className="text-cs2-orange">{info.latest_version}</span>
              {info.current_version ? (
                <>
                  {" "}
                  · {t("dialog.updateCurrentVersion")} <span className="text-zinc-300">{info.current_version}</span>
                </>
              ) : null}
            </p>
          ) : null}
          {info.update_via_mirror ? (
            <p className="mt-1 text-[10px] text-zinc-500">
              {t("dialog.updateViaMirror")}{info.update_via_mirror.replace(/^https?:\/\//, "")}
            </p>
          ) : null}
        </div>
        <div className="max-h-[45vh] overflow-y-auto px-4 py-3">
          {err ? (
            <p className="text-[12px] text-red-400">{err}</p>
          ) : upToDate ? (
            <p className="text-sm text-zinc-300">{t("dialog.updateUpToDate")}</p>
          ) : null}
          {!err && notes ? (
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-zinc-300">
              {notes}
            </pre>
          ) : null}
          {!err && !notes && !upToDate ? <p className="text-[12px] text-zinc-500">{t("dialog.updateNoNotes")}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-white/10 px-4 py-3">
          {info.downloads?.setup_url ? (
            <a
              className="rounded-lg bg-cs2-orange px-3 py-1.5 text-[11px] font-semibold text-black hover:opacity-90"
              href={info.downloads.setup_url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("dialog.updateDownloadSetup")}
            </a>
          ) : null}
          {info.downloads?.zip_url ? (
            <a
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-white/5"
              href={info.downloads.zip_url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("dialog.updateDownloadZip")}
            </a>
          ) : null}
          {info.release_url ? (
            <a
              className="ml-auto rounded-lg px-3 py-1.5 text-[11px] font-semibold text-zinc-400 hover:text-white"
              href={info.release_url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("dialog.updateOpenGithub")}
            </a>
          ) : null}
        </div>
        <div className="border-t border-white/10 px-4 py-2 text-right">
          <button type="button" className="text-[11px] font-semibold text-zinc-500 hover:text-white" onClick={onClose}>
            {t("dialog.updateClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
