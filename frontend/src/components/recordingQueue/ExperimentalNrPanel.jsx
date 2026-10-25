import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, FlaskConical, FolderOpen, Gauge, Loader2, Play, ScanLine } from "lucide-react";
import { useT } from "../../i18n/useT.js";

/** 后端 probe_environment() 返回的缺失项代码 → i18n key。 */
const MISSING_LABELS = {
  AMD_GPU: "queue.expMissingAmdGpu",
  CS2_EXE: "queue.expMissingCs2Exe",
  NR_RUNTIME: "queue.expMissingRuntime",
  PRO_AGENT: "queue.expMissingProAgent",
};

function missingLabel(t, code) {
  return MISSING_LABELS[code] ? t(MISSING_LABELS[code]) : code;
}

/**
 * 录制队列里的「游戏内神经重画（实验性）」面板。
 *
 * @param {{
 *   enabled: boolean,
 *   onToggle?: (next: boolean) => void,
 *   disabled?: boolean,
 *   status: { state: "idle" | "checking" | "ready" | "unsupported" | "error", data?: any, message?: string },
 *   onCheck?: () => void,
 *   plan?: { demoPath: string, demoFile?: string, startTick: number, endTick: number, durationSec?: number } | null,
 *   planStatus?: "loading" | "ready" | "missing" | "error",
 *   running?: boolean,
 *   startedAt?: number | null,
 *   result?: { ok: boolean, message?: string, finalOutput?: string, output?: string, logPath?: string, elapsedSec?: number } | null,
 *   onRun?: () => void,
 * }} props
 */
export default function ExperimentalNrPanel({
  enabled = false,
  onToggle,
  disabled = false,
  status = { state: "idle" },
  onCheck,
  plan = null,
  planStatus = "missing",
  running = false,
  startedAt = null,
  result = null,
  onRun,
}) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const state = running ? "running" : status?.state || "idle";
  const data = status?.data || {};
  const gpus = Array.isArray(data?.gpus) ? data.gpus : [];
  const missing = Array.isArray(data?.missing) ? data.missing : [];
  const elapsedSec = running && startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;

  const planText =
    planStatus === "loading"
      ? t("queue.expPlanLoading")
      : plan
        ? `${((plan.endTick - plan.startTick) / 64).toFixed(2)}s · ${plan.demoFile || plan.demoPath?.split(/[\\/]/).pop() || ""}`
        : t("queue.expPlanMissing");

  const ready = status?.state === "ready" && !!plan && planStatus === "ready";
  const canRun = enabled && ready && !running && !disabled;

  const statusTone =
    state === "ready"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : state === "checking" || state === "running"
        ? "border-sky-500/40 bg-sky-500/10 text-sky-300"
        : state === "unsupported" || state === "error"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
          : "border-cs2-border bg-cs2-bg-page text-cs2-text-muted";

  const statusText =
    state === "checking"
      ? t("queue.expStatusChecking")
      : state === "ready"
        ? t("queue.expStatusReady")
        : state === "unsupported"
          ? t("queue.expStatusUnsupported")
          : state === "error"
            ? t("queue.expStatusError")
            : state === "running"
              ? t("queue.expStatusRunning")
              : t("queue.expStatusIdle");

  return (
    <section
      data-testid="recording-experimental-nr-panel"
      className={`w-full rounded-lg border border-cs2-border bg-cs2-bg-card/80 px-3 py-2.5 transition-colors ${
        enabled ? "ring-1 ring-cs2-accent/30" : ""
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical className={`h-3.5 w-3.5 ${enabled ? "text-cs2-accent" : "text-cs2-text-muted"}`} />
          <span className="text-[12px] font-semibold text-cs2-text-secondary">{t("queue.expTitle")}</span>
          <span className="rounded border border-cs2-accent/40 bg-cs2-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-cs2-accent">
            {t("queue.expBadge")}
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-cs2-border px-1.5 py-0.5 font-mono text-[10px] text-cs2-text-muted">
            <Cpu className="h-2.5 w-2.5" />
            {t("queue.expOnlyAmd")}
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-cs2-border px-1.5 py-0.5 font-mono text-[10px] text-cs2-text-muted">
            <Gauge className="h-2.5 w-2.5" />
            {t("queue.expSlow")}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          data-testid="recording-experimental-nr-toggle"
          title={t("queue.expDesc")}
          disabled={disabled || running}
          onClick={() => onToggle?.(!enabled)}
          className={`relative inline-flex h-4 w-8 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            enabled ? "bg-cs2-accent" : "bg-cs2-border"
          }`}
        >
          <span
            className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-cs2-text-muted">{t("queue.expDesc")}</p>

      {enabled ? (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 font-mono text-[11px] ${statusTone}`}>
              {state === "checking" || state === "running" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : state === "ready" ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              {statusText}
            </span>
            {gpus.length ? (
              <span className="inline-flex items-center gap-1 rounded border border-cs2-border px-2 py-1 font-mono text-[11px] text-cs2-text-secondary">
                <Cpu className="h-3 w-3 text-cs2-text-muted" />
                {gpus.join(" / ")}
              </span>
            ) : null}
            <span
              title={planText}
              className="inline-flex max-w-[360px] items-center gap-1 rounded border border-cs2-border px-2 py-1 font-mono text-[11px] text-cs2-text-secondary"
            >
              <ScanLine className="h-3 w-3 shrink-0 text-cs2-text-muted" />
              <span className="shrink-0">{t("queue.expPlan")}：</span>
              <span className="truncate">{planText}</span>
            </span>
            {running ? (
              <span className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 font-mono text-[11px] text-sky-300">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("queue.expElapsed")} {Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, "0")}
              </span>
            ) : null}
          </div>

          {missing.length ? (
            <p className="font-mono text-[11px] text-amber-300/90">
              {t("queue.expMissing")}：{missing.map((code) => missingLabel(t, code)).join(" / ")}
            </p>
          ) : null}

          {status?.message ? <p className="font-mono text-[11px] text-amber-300/90">{status.message}</p> : null}

          {result ? (
            <div
              data-testid="recording-experimental-nr-result"
              className={`space-y-0.5 rounded-md border px-2 py-1.5 font-mono text-[11px] ${
                result.ok ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : "border-red-500/30 bg-red-500/5 text-red-300"
              }`}
            >
              <div className="flex items-center gap-1">
                {result.ok ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : <AlertTriangle className="h-3 w-3 shrink-0" />}
                <span className="shrink-0 font-semibold">{result.ok ? t("queue.expDone") : t("queue.expFailed")}</span>
                <span className="shrink-0 text-cs2-text-muted">{t("queue.expOutput")}：</span>
                <span className="truncate" title={result.finalOutput || result.output || ""}>
                  {result.finalOutput || result.output || result.message || ""}
                </span>
              </div>
              {result.logPath ? (
                <div className="flex items-center gap-1 text-cs2-text-muted">
                  <span className="shrink-0">{t("queue.expLog")}：</span>
                  <span className="truncate" title={result.logPath}>
                    {result.logPath}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="recording-experimental-nr-check"
              disabled={state === "checking" || running}
              onClick={() => onCheck?.()}
              className="inline-flex items-center gap-1 rounded-md border border-cs2-border px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/50 hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-35"
            >
              {state === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanLine className="h-3 w-3" />}
              {state === "idle" ? t("queue.expCheck") : t("queue.expRecheck")}
            </button>
            <button
              type="button"
              data-testid="recording-experimental-nr-run"
              disabled={!canRun}
              onClick={() => onRun?.()}
              className="inline-flex items-center gap-1 rounded-md bg-cs2-accent px-2.5 py-1.5 text-[11px] font-bold text-cs2-text-on-accent transition-colors hover:bg-cs2-accent-light disabled:cursor-not-allowed disabled:opacity-35"
            >
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              {running ? t("queue.expRunning") : t("queue.expStart")}
            </button>
            {data?.log_dir ? (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-cs2-text-muted">
                <FolderOpen className="h-3 w-3" />
                {data.log_dir}
              </span>
            ) : null}
            {!ready && !running && state !== "checking" ? (
              <span className="font-mono text-[10px] text-cs2-text-muted">{t("queue.expNeedReady")}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
