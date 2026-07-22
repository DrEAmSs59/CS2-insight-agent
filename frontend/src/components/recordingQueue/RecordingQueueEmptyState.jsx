import { Link } from "react-router-dom";
import { Library, Clapperboard } from "lucide-react";
import { useT } from "../../i18n/useT.js";

export default function RecordingQueueEmptyState() {
  const t = useT();
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center rounded-xl border border-dashed border-cs2-border bg-cs2-bg-input/30 px-6 py-12 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-cs2-border bg-gradient-to-br from-cs2-orange/20 to-zinc-900/80">
        <Clapperboard className="h-8 w-8 text-cs2-accent/90" aria-hidden />
      </div>
      <h3 className="text-sm font-bold text-cs2-text-primary">{t("queue.emptyTitle")}</h3>
      <p className="mt-2 max-w-sm text-[11px] leading-relaxed text-cs2-text-muted">
        {t("queue.emptyBody")}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Link
          to="/library"
          className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-accent/45 bg-cs2-accent/10 px-3 py-2 text-[11px] font-semibold text-cs2-accent transition-colors hover:bg-cs2-accent/20"
        >
          <Library className="h-3.5 w-3.5" />
          {t("queue.emptyLinkLibrary")}
        </Link>
      </div>
    </div>
  );
}
