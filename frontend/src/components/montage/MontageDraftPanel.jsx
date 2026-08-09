import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  Clock3,
  FileVideo2,
  Loader2,
  Music,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import API from "../../api/api";
import { useT } from "../../i18n/useT.js";

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16).replace("T", " ");
  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MontageDraftPanel({ open, onClose, onOpenDraft, onDeleteDraft }) {
  const t = useT();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [openingId, setOpeningId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await API.get("/montage/projects", {
        params: { limit: 100, offset: 0 },
      });
      setItems(Array.isArray(data?.items) ? data.items : []);
      setTotal(Number(data?.total) || 0);
    } catch {
      setError(t("montage.draftsLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const handleOpen = useCallback(async (item) => {
    setOpeningId(item.id);
    setError("");
    try {
      const { data } = await API.get(`/montage/projects/${item.id}`);
      const opened = await onOpenDraft?.(data);
      if (opened !== false) onClose?.();
    } catch {
      setError(t("montage.draftsOpenFailed"));
    } finally {
      setOpeningId(null);
    }
  }, [onClose, onOpenDraft, t]);

  const handleDelete = useCallback(async (item) => {
    if (!window.confirm(t("montage.draftsDeleteConfirm", { name: item.name || item.output_filename }))) return;
    setDeletingId(item.id);
    setError("");
    try {
      await API.delete(`/montage/projects/${item.id}`);
      setItems((current) => current.filter((draft) => draft.id !== item.id));
      setTotal((current) => Math.max(0, current - 1));
      onDeleteDraft?.(item.id);
    } catch {
      setError(t("montage.draftsDeleteFailed"));
    } finally {
      setDeletingId(null);
    }
  }, [onDeleteDraft, t]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-6">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="montage-drafts-title"
          className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-cs2-border bg-cs2-bg-card shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-cs2-border px-5 py-4">
            <Archive className="h-5 w-5 shrink-0 text-cs2-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 id="montage-drafts-title" className="text-[15px] font-bold text-cs2-text-primary">
                {t("montage.draftsTitle")}
              </h2>
              <p className="mt-0.5 text-xs text-cs2-text-muted">
                {t("montage.draftsSubtitle", { n: total })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              aria-label={t("montage.draftsRefresh")}
              className="rounded-lg p-2 text-cs2-text-muted transition-colors hover:bg-cs2-surface-2 hover:text-cs2-text-primary disabled:opacity-40"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("montage.draftsClose")}
              className="rounded-lg p-2 text-cs2-text-muted transition-colors hover:bg-cs2-surface-2 hover:text-cs2-text-primary"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {error ? (
              <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            ) : null}

            {loading && items.length === 0 ? (
              <div className="flex min-h-52 items-center justify-center text-cs2-text-muted">
                <Loader2 className="h-5 w-5 animate-spin" aria-label={t("montage.draftsLoading")} />
              </div>
            ) : items.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-cs2-border-subtle bg-cs2-surface-1/50 px-5 text-center">
                <Archive className="h-8 w-8 text-cs2-text-muted" aria-hidden />
                <p className="mt-3 text-sm font-semibold text-cs2-text-secondary">{t("montage.draftsEmptyTitle")}</p>
                <p className="mt-1 text-xs text-cs2-text-muted">{t("montage.draftsEmptyHint")}</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {items.map((item) => {
                  const busy = openingId === item.id || deletingId === item.id;
                  return (
                    <article
                      key={item.id}
                      className="flex items-center gap-3 rounded-xl border border-cs2-border-subtle bg-cs2-surface-1 p-3.5 transition-colors hover:border-cs2-border-focus"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cs2-bg-input text-cs2-accent">
                        <FileVideo2 className="h-5 w-5" aria-hidden />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-cs2-text-primary">
                          {item.name || item.output_filename || t("montage.untitledMontage")}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cs2-text-muted">
                          <span>{t("montage.draftsClipCount", { n: Number(item.clip_count) || 0 })}</span>
                          <span className="inline-flex items-center gap-1">
                            <Clock3 className="h-3 w-3" aria-hidden />
                            {formatDateTime(item.updated_at)}
                          </span>
                          {item.has_bgm ? (
                            <span className="inline-flex items-center gap-1 text-violet-300">
                              <Music className="h-3 w-3" aria-hidden />
                              {t("montage.draftsHasBgm")}
                            </span>
                          ) : null}
                        </div>
                        {item.output_filename ? (
                          <p className="mt-1 truncate font-mono text-[10px] text-cs2-text-muted" title={item.output_filename}>
                            {item.output_filename}
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleOpen(item)}
                        disabled={busy}
                        className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-cs2-accent px-3.5 text-xs font-bold text-cs2-text-on-accent transition-opacity hover:opacity-90 disabled:opacity-45"
                      >
                        {openingId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("montage.draftsOpenBtn")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(item)}
                        disabled={busy}
                        aria-label={t("montage.draftsDeleteBtn", { name: item.name || item.output_filename })}
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cs2-border-subtle text-cs2-text-muted transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                      >
                        {deletingId === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
