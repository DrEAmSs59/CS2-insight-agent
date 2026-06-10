import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/api";
import { getObsConfigStatus } from "../api/obsConfigCenter";
import { useAppShell } from "../context/AppShellContext";
import { obsConfigHasIssues } from "../utils/obsConfigHealth";
import { useT } from "../i18n/useT.js";
import {
  BookOpen,
  Clapperboard,
  Library,
  Microscope,
  Package,
  SlidersHorizontal,
  Settings,
  Gamepad2,
  RadioTower,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";

// ─── Setup checklist ────────────────────────────────────────────

function StatusDot({ ok, loading }) {
  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />;
  if (ok) return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  return <XCircle className="h-4 w-4 text-red-400" />;
}

function SetupChecklist() {
  const t = useT();
  const { initialQuickCheckStatus } = useAppShell();
  const [status, setStatus] = useState(() => initialQuickCheckStatus ?? null);
  const [loading, setLoading] = useState(() => initialQuickCheckStatus == null);
  const [refreshing, setRefreshing] = useState(false);
  const [obsConfigHasIssuesState, setObsConfigHasIssues] = useState(/** @type {boolean | null} */ (null));
  const timerRef = useRef(null);

  const SETUP_ITEMS = [
    {
      key: "obs_configured",
      required: true,
      label: t("guide.setupObsLabel"),
      desc: t("guide.setupObsDesc"),
      to: "/obs-config-center",
      linkLabel: t("guide.setupObsLink"),
    },
    {
      key: "cs2_path_ok",
      required: true,
      label: t("guide.setupCs2Label"),
      desc: t("guide.setupCs2Desc"),
      to: "/settings",
      linkLabel: t("guide.setupSettingsLink"),
    },
    {
      key: "ffmpeg_ok",
      required: false,
      label: t("guide.setupFfmpegLabel"),
      desc: t("guide.setupFfmpegDesc"),
      to: "/settings",
      linkLabel: t("guide.setupSettingsLink"),
    },
    {
      key: "ai_key_ok",
      required: false,
      label: t("guide.setupAiLabel"),
      desc: t("guide.setupAiDesc"),
      to: "/settings",
      linkLabel: t("guide.setupSettingsLink"),
    },
  ];

  const fetchStatus = async (isBackground = false) => {
    if (!isBackground) setLoading(true);
    try {
      const { data } = await API.get("/config/quick-check");
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      if (!isBackground) setLoading(false);
    }
  };

  // OBS 已配置时拉一次配置健康状态（随 setup 刷新同步）
  const fetchObsConfigHealth = async () => {
    try {
      const st = await getObsConfigStatus();
      if (!st?.obs_connected) { setObsConfigHasIssues(null); return; }
      setObsConfigHasIssues(obsConfigHasIssues(st));
    } catch {
      setObsConfigHasIssues(null);
    }
  };

  useEffect(() => {
    if (initialQuickCheckStatus != null) {
      setStatus(initialQuickCheckStatus);
      setLoading(false);
    } else {
      void fetchStatus(false);
    }
    // quick-check 不连 OBS 很快，保留轮询以反映配置变化
    timerRef.current = setInterval(() => fetchStatus(true), 15000);
    return () => clearInterval(timerRef.current);
  }, [initialQuickCheckStatus]);

  // OBS 配置状态变化时同步拉配置健康
  useEffect(() => {
    if (status?.obs_configured) {
      void fetchObsConfigHealth();
    } else {
      setObsConfigHasIssues(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.obs_configured]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchStatus(true);
      if (status?.obs_configured) await fetchObsConfigHealth();
    } finally {
      setRefreshing(false);
    }
  };

  const allRequired =
    status?.obs_configured && status?.cs2_path_ok;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-bold uppercase tracking-widest text-zinc-500">
          {t("guide.checklistTitle")}
        </h2>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-white/5 hover:text-dynamic-zinc-300 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
          {t("guide.checklistRefresh")}
        </button>
      </div>

      {allRequired && !loading && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {t("guide.checklistAllReady")}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {SETUP_ITEMS.map(({ key, required, label, desc, to, linkLabel }) => {
          const ok = status?.[key] ?? false;
          const pending = loading || status == null;
          const isObs = key === "obs_configured";
          return (
            <div
              key={key}
              className={`rounded-xl border px-4 py-3 transition-colors ${
                pending
                  ? "border-white/8 bg-cs2-bg-card/70"
                  : ok
                  ? "border-emerald-500/20 bg-emerald-500/5"
                  : required
                  ? "border-red-500/20 bg-red-500/5"
                  : "border-white/8 bg-cs2-bg-card/70"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 shrink-0">
                  <StatusDot ok={ok} loading={loading} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-dynamic-white">{label}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        required
                          ? "bg-cs2-orange/20 text-cs2-orange"
                          : "bg-zinc-700/60 text-dynamic-zinc-400"
                      }`}
                    >
                      {required ? t("guide.tagRequired") : t("guide.tagOptional")}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{desc}</p>
                  {!ok && (
                    <Link
                      to={to}
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-cs2-orange hover:underline"
                    >
                      {t("guide.setupGoTo", { link: linkLabel })}
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  )}
                  {/* OBS 连通后的录制配置子项 */}
                  {isObs && ok && obsConfigHasIssuesState !== null && (
                    <div className={`mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] ${
                      obsConfigHasIssuesState
                        ? "border-amber-500/25 bg-amber-500/8 text-amber-300"
                        : "border-emerald-500/20 bg-emerald-500/8 text-emerald-300"
                    }`}>
                      {obsConfigHasIssuesState
                        ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      }
                      <div>
                        <span className="font-semibold">
                          {obsConfigHasIssuesState ? t("guide.obsConfigIssues") : t("guide.obsConfigOk")}
                        </span>
                        <span className="ml-1 text-zinc-500">
                          {obsConfigHasIssuesState
                            ? t("guide.obsConfigIssuesDetail")
                            : t("guide.obsConfigOkDetail")
                          }
                        </span>
                        {obsConfigHasIssuesState && (
                          <Link
                            to="/obs-config-center"
                            className="ml-2 font-semibold text-cs2-orange hover:underline"
                          >
                            {t("guide.obsConfigFix")}
                          </Link>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Quick‑start steps ──────────────────────────────────────────

function QuickStart() {
  const t = useT();

  const STEPS = [
    { step: "1", text: t("guide.step1") },
    { step: "2", text: t("guide.step2") },
    { step: "3", text: t("guide.step3") },
    { step: "4", text: t("guide.step4") },
  ];

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-bold uppercase tracking-widest text-zinc-500">
        {t("guide.quickStartTitle")}
      </h2>
      <div className="flex flex-wrap gap-2">
        {STEPS.map(({ step, text }, i) => (
          <div key={step} className="flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cs2-orange/20 font-mono text-[11px] font-bold text-cs2-orange">
              {step}
            </div>
            <span className="text-[12px] text-dynamic-zinc-300">{text}</span>
            {i < STEPS.length - 1 && (
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Feature nav cards ──────────────────────────────────────────

function FeatureCards() {
  const t = useT();

  const NAV_CARDS = [
    { to: "/library", label: t("guide.navLibrary"), desc: t("guide.navLibraryDesc"), icon: Library },
    { to: "/analysis", label: t("guide.navAnalysis"), desc: t("guide.navAnalysisDesc"), icon: Microscope },
    { to: "/queue", label: t("guide.navQueue"), desc: t("guide.navQueueDesc"), icon: Package },
    { to: "/montage", label: t("guide.navMontage"), desc: t("guide.navMontageDesc"), icon: Clapperboard },
    { to: "/obs-config-center", label: t("guide.navObsConfig"), desc: t("guide.navObsConfigDesc"), icon: RadioTower },
    { to: "/params", label: t("guide.navParams"), desc: t("guide.navParamsDesc"), icon: SlidersHorizontal },
    { to: "/player-game-config", label: t("guide.navPlayerConfig"), desc: t("guide.navPlayerConfigDesc"), icon: Gamepad2 },
    { to: "/settings", label: t("guide.navSettings"), desc: t("guide.navSettingsDesc"), icon: Settings },
  ];

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-bold uppercase tracking-widest text-zinc-500">
        {t("guide.featureCardsTitle")}
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {NAV_CARDS.map(({ to, label, desc, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="group flex items-center gap-3 rounded-xl border border-white/8 bg-cs2-bg-card/80 px-3 py-3 transition-colors hover:border-cs2-orange/30 hover:bg-cs2-bg-card"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cs2-orange/12 text-cs2-orange transition-colors group-hover:bg-cs2-orange/22">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[12px] font-bold text-dynamic-white">{label}</p>
              <p className="truncate text-[11px] text-zinc-500">{desc}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ─── FAQ accordion ──────────────────────────────────────────────

function FaqAccordion() {
  const t = useT();
  const [openIdx, setOpenIdx] = useState(null);

  const FAQ_ITEMS = [
    { q: t("guide.faq1q"), a: t("guide.faq1a") },
    { q: t("guide.faq2q"), a: t("guide.faq2a") },
    { q: t("guide.faq3q"), a: t("guide.faq3a") },
    { q: t("guide.faq4q"), a: t("guide.faq4a") },
    { q: t("guide.faq5q"), a: t("guide.faq5a") },
    { q: t("guide.faq6q"), a: t("guide.faq6a") },
    { q: t("guide.faq7q"), a: t("guide.faq7a") },
    { q: t("guide.faq8q"), a: t("guide.faq8a") },
    { q: t("guide.faq9q"), a: t("guide.faq9a") },
    { q: t("guide.faq10q"), a: t("guide.faq10a") },
    { q: t("guide.faq11q"), a: t("guide.faq11a") },
    { q: t("guide.faq12q"), a: t("guide.faq12a") },
    { q: t("guide.faq13q"), a: t("guide.faq13a") },
    { q: t("guide.faq14q"), a: t("guide.faq14a") },
    { q: t("guide.faq15q"), a: t("guide.faq15a") },
    { q: t("guide.faq16q"), a: t("guide.faq16a") },
    { q: t("guide.faq17q"), a: t("guide.faq17a") },
    { q: t("guide.faq18q"), a: t("guide.faq18a") },
    { q: t("guide.faq19q"), a: t("guide.faq19a") },
    { q: t("guide.faq20q"), a: t("guide.faq20a") },
    { q: t("guide.faq21q"), a: t("guide.faq21a") },
  ];

  return (
    <section>
      <h2 className="mb-3 text-[13px] font-bold uppercase tracking-widest text-zinc-500">
        {t("guide.faqTitle")}
      </h2>
      <div className="divide-y divide-white/8 rounded-xl border border-white/8 bg-cs2-bg-card/60">
        {FAQ_ITEMS.map(({ q, a }, i) => {
          const open = openIdx === i;
          return (
            <div key={i}>
              <button
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/[0.03]"
                onClick={() => setOpenIdx(open ? null : i)}
              >
                <span className="text-[12px] font-semibold text-dynamic-zinc-200">{q}</span>
                {open ? (
                  <ChevronUp className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}
              </button>
              {open && (
                <div className="border-t border-white/6 px-4 py-3">
                  <p className="text-[12px] leading-relaxed text-dynamic-zinc-400">{a}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

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
