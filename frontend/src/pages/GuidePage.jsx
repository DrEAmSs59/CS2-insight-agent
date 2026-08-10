import { useT } from "../i18n/useT.js";
import { BookOpen } from "lucide-react";
import { FaqAccordion, FeatureCards, QuickStart, SetupChecklist } from "./guide/GuideSections.jsx";

// ─── Setup checklist ────────────────────────────────────────────

// ─── Page root ──────────────────────────────────────────────────

export default function GuidePage() {
  const t = useT();
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto px-4 py-4 sm:px-5">
      {/* header */}
      <div className="mb-5 shrink-0 border-b border-white/10 pb-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-cs2-orange" />
          <h1 className="text-xl font-bold text-dynamic-white">{t("guide.pageTitle")}</h1>
        </div>
        <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-zinc-500">
          {t("guide.pageSubtitle")}
        </p>
      </div>

      <div className="flex flex-col gap-7">
        <QuickStart />
        <SetupChecklist />
        <FeatureCards />
        <FaqAccordion />
      </div>

      {/* footer padding */}
      <div className="h-6 shrink-0" />
    </div>
  );
}
