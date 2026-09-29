import { useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Megaphone } from "lucide-react";
import { desktopBridge } from "../../desktop/desktopBridge.js";
import { useLocaleStore } from "../../i18n/localeStore.js";
import { useT } from "../../i18n/useT.js";

function openLink(url) {
  if (desktopBridge?.openExternal) {
    void desktopBridge.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export default function AnnouncementBanner({ items = [] }) {
  const t = useT();
  const effectiveLocale = useLocaleStore((s) => s.effectiveLocale);
  const [index, setIndex] = useState(0);

  if (items.length === 0) return null;
  const currentIndex = Math.min(index, items.length - 1);
  const item = items[currentIndex];
  const warning = item.level === "warning";
  const body = effectiveLocale === "en" && item.body_en ? item.body_en : item.body_zh;
  const Icon = warning ? AlertTriangle : Megaphone;

  return (
    <div className="mb-4 shrink-0">
      <div
        data-announcement-level={warning ? "warning" : "info"}
        className={`rounded-xl border px-3 py-3 ${
          warning
            ? "border-amber-500/40 bg-amber-500/10"
            : "border-white/10 bg-cs2-bg-card"
        }`}
      >
        <div className="mb-2 flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold ${
              warning ? "bg-amber-500 text-black" : "bg-cs2-accent text-white"
            }`}
          >
            <Icon className="h-3 w-3" />
            {t("guide.announcementLabel")}
          </span>
          {warning && (
            <span className="text-[11px] font-semibold text-amber-300">
              {t("guide.announcementImportant")}
            </span>
          )}
          {items.length > 1 && (
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label={t("guide.announcementPrevious")}
                disabled={currentIndex === 0}
                onClick={() => setIndex(currentIndex - 1)}
                className="rounded p-0.5 text-zinc-400 hover:bg-white/5 hover:text-dynamic-zinc-200 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-8 text-center font-mono text-[11px] text-zinc-400">
                {t("guide.announcementPosition", { current: currentIndex + 1, total: items.length })}
              </span>
              <button
                type="button"
                aria-label={t("guide.announcementNext")}
                disabled={currentIndex === items.length - 1}
                onClick={() => setIndex(currentIndex + 1)}
                className="rounded p-0.5 text-zinc-400 hover:bg-white/5 hover:text-dynamic-zinc-200 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        <div
          data-announcement-body
          className={`rounded-lg border px-3 py-2.5 text-[12px] leading-relaxed ${
            warning
              ? "border-amber-500/20 bg-black/25 text-amber-100"
              : "border-white/8 bg-black/20 text-dynamic-zinc-200"
          }`}
        >
          <p className="whitespace-pre-line break-words">{body}</p>
          {item.link_url && (
            <button
              type="button"
              onClick={() => openLink(item.link_url)}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-cs2-orange hover:underline"
            >
              {t("guide.announcementDetails")}
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
