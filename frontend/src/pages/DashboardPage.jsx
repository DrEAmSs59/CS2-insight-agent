import { Link } from "react-router-dom";
import {
  Library,
  Microscope,
  Package,
  Clapperboard,
  SlidersHorizontal,
  Settings,
  Brain,
  Zap,
  Gamepad2,
} from "lucide-react";
import { useAppShell } from "../context/AppShellContext";
import { useT } from "../i18n/useT.js";

export default function DashboardPage() {
  const t = useT();
  const s = useAppShell();
  const nDemos = s.uploadedDemos?.length ?? 0;
  const q = s.queue?.length ?? 0;
  const libTotal = s.libraryTotal;

  const cards = [
    {
      to: "/library",
      label: t("dashboard.cardLibraryLabel"),
      desc: t("dashboard.cardLibraryDesc"),
      icon: Library,
      hint: libTotal != null ? t("dashboard.cardLibraryHintTotal", { n: libTotal }) : t("dashboard.cardLibraryHintBrowse"),
    },
    {
      to: "/analysis",
      label: t("dashboard.cardAnalysisLabel"),
      desc: t("dashboard.cardAnalysisDesc"),
      icon: Microscope,
      hint: nDemos ? t("dashboard.cardAnalysisHintN", { n: nDemos }) : t("dashboard.cardAnalysisHintUpload"),
    },
    {
      to: "/queue",
      label: t("dashboard.cardQueueLabel"),
      desc: t("dashboard.cardQueueDesc"),
      icon: Package,
      hint: t("dashboard.cardQueueHint", { n: q }),
    },
    {
      to: "/montage",
      label: t("dashboard.cardMontageLabel"),
      desc: t("dashboard.cardMontageDesc"),
      icon: Clapperboard,
      hint: t("dashboard.cardMontageHint"),
    },
    {
      to: "/params",
      label: t("dashboard.cardParamsLabel"),
      desc: t("dashboard.cardParamsDesc"),
      icon: SlidersHorizontal,
      hint: t("dashboard.cardParamsHint"),
    },
    {
      to: "/player-game-config",
      label: t("dashboard.cardPlayerCfgLabel"),
      desc: t("dashboard.cardPlayerCfgDesc"),
      icon: Gamepad2,
      hint: t("dashboard.cardPlayerCfgHint"),
    },
    {
      to: "/settings",
      label: t("dashboard.cardSettingsLabel"),
      desc: t("dashboard.cardSettingsDesc"),
      icon: Settings,
      hint: t("dashboard.cardSettingsHint"),
    },
  ];

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto px-4 py-4 sm:px-5">
      <div className="mb-6 shrink-0 border-b border-cs2-border pb-5">
        <h1 className="text-xl font-bold text-cs2-text-primary">{t("dashboard.pageTitle")}</h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-cs2-text-muted">
          {t("dashboard.pageSubtitle")}
        </p>
        <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-card px-3 py-2 text-[11px] text-cs2-text-secondary">
          <span className="font-semibold text-cs2-text-muted">{t("dashboard.analysisMode")}</span>
          {s.aiMode ? (
            <span className="inline-flex items-center gap-1 font-bold text-cs2-accent">
              <Brain className="h-3.5 w-3.5" /> {t("dashboard.modeAi")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-bold text-cs2-text-secondary">
              <Zap className="h-3.5 w-3.5" /> {t("dashboard.modeLocal")}
            </span>
          )}
          <span className="text-cs2-text-muted">·</span>
          <Link to="/settings" className="text-cs2-accent hover:underline">
            {t("dashboard.switchInSettings")}
          </Link>
        </div>
      </div>

      <div className="grid min-h-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {cards.map(({ to, label, desc, icon: Icon, hint }) => (
          <Link
            key={to}
            to={to}
            className="group rounded-xl border border-cs2-border bg-cs2-bg-card/90 px-4 py-4 transition-colors hover:border-cs2-accent/35 hover:bg-cs2-bg-card"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cs2-accent/15 text-cs2-accent transition-colors group-hover:bg-cs2-accent/25">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-cs2-text-primary">{label}</p>
                <p className="mt-1 text-[12px] leading-snug text-cs2-text-muted">{desc}</p>
                <p className="mt-2 font-mono text-[10px] text-cs2-text-muted">{hint}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
