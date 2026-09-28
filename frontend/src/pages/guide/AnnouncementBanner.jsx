import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Megaphone, X } from "lucide-react";
import API from "../../api/api";
import { desktopBridge } from "../../desktop/desktopBridge.js";
import { useLocaleStore } from "../../i18n/localeStore.js";
import { useT } from "../../i18n/useT.js";

export const DISMISSED_ANNOUNCEMENTS_KEY = "cs2-insight-dismissed-announcements";
const MAX_REMEMBERED_DISMISSALS = 50;

function readDismissed() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISMISSED_ANNOUNCEMENTS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberDismissed(ids) {
  try {
    window.localStorage.setItem(
      DISMISSED_ANNOUNCEMENTS_KEY,
      JSON.stringify(ids.slice(-MAX_REMEMBERED_DISMISSALS)),
    );
  } catch {
    // Storage may be unavailable; the announcement then stays hidden only for this visit.
  }
}

function openLink(url) {
  if (desktopBridge?.openExternal) {
    void desktopBridge.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export default function AnnouncementBanner() {
  const t = useT();
  const effectiveLocale = useLocaleStore((s) => s.effectiveLocale);
  const [items, setItems] = useState([]);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    let cancelled = false;
    API.get("/app/announcements")
      .then(({ data }) => {
        if (!cancelled) setItems(Array.isArray(data?.announcements) ? data.announcements : []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = items.filter((item) => !dismissed.includes(item.id));
  if (visible.length === 0) return null;

  const dismiss = (id) => {
    const next = [...dismissed.filter((value) => value !== id), id];
    setDismissed(next);
    rememberDismissed(next);
  };

  return (
    <div className="mb-4 flex shrink-0 flex-col gap-2">
      {visible.map((item) => {
        const warning = item.level === "warning";
        const body = effectiveLocale === "en" && item.body_en ? item.body_en : item.body_zh;
        const Icon = warning ? AlertTriangle : Megaphone;
        return (
          <div
            key={item.id}
            data-announcement-level={warning ? "warning" : "info"}
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-[12px] leading-relaxed ${
              warning
                ? "border-amber-500/25 bg-amber-500/8 text-amber-300"
                : "border-white/8 bg-cs2-bg-card text-dynamic-zinc-300"
            }`}
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${warning ? "" : "text-cs2-orange"}`} />
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-line break-words">{body}</p>
              {item.link_url && (
                <button
                  type="button"
                  onClick={() => openLink(item.link_url)}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-cs2-orange hover:underline"
                >
                  {t("guide.announcementDetails")}
                  <ExternalLink className="h-3 w-3" />
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label={t("guide.announcementDismiss")}
              onClick={() => dismiss(item.id)}
              className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-white/5 hover:text-dynamic-zinc-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
