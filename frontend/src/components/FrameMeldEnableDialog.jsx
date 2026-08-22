import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Info } from "lucide-react";

import { useT } from "../i18n/useT.js";
import Modal from "./ui/Modal.jsx";

const CONFIRM_DELAY_SECONDS = 3;
const BENCHMARK_KEYS = [
  "frameMeld.enableDialog.benchmark5070Ti",
  "frameMeld.enableDialog.benchmark5070",
  "frameMeld.enableDialog.benchmark6600Xt",
  "frameMeld.enableDialog.benchmark9070Xt",
];
const INTERPOLATION_STRATEGY_ROWS = [
  "60",
  "90",
  "120",
  "144",
  "180",
  "240",
];
const STRATEGY_TOOLTIP_ID = "framemeld-interpolation-strategy";

function InterpolationStrategyDetails({ t }) {
  return (
    <>
      <p className="text-xs font-bold text-cs2-accent">{t("frameMeld.enableDialog.strategyTitle")}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-cs2-text-muted">
        {t("frameMeld.enableDialog.strategyIntro")}
      </p>
      <div className="mt-3 overflow-hidden rounded-md border border-cs2-border/80" role="table">
        <div className="grid grid-cols-[minmax(72px,0.65fr)_minmax(0,1fr)_minmax(0,1fr)] bg-cs2-bg-hover text-[10px] font-semibold leading-snug text-cs2-text-primary" role="row">
          <span className="border-r border-cs2-border/80 px-3 py-2" role="columnheader">
            {t("frameMeld.enableDialog.strategySourceHeader")}
          </span>
          <span className="border-r border-cs2-border/80 px-3 py-2" role="columnheader">
            {t("frameMeld.enableDialog.strategyStandardHeader")}
          </span>
          <span className="px-3 py-2" role="columnheader">
            {t("frameMeld.enableDialog.strategyFastHeader")}
          </span>
        </div>
        {INTERPOLATION_STRATEGY_ROWS.map((frameRate, index) => (
          <div
            key={frameRate}
            className={`grid grid-cols-[minmax(72px,0.65fr)_minmax(0,1fr)_minmax(0,1fr)] text-[10px] leading-relaxed text-cs2-text-secondary ${index ? "border-t border-cs2-border/70" : ""}`}
            role="row"
          >
            <span className="border-r border-cs2-border/70 px-3 py-2 font-medium text-cs2-text-primary" role="cell">
              {frameRate} FPS
            </span>
            <span className="border-r border-cs2-border/70 px-3 py-2" role="cell">
              {t(`frameMeld.enableDialog.strategyStandard${frameRate}`)}
            </span>
            <span className="px-3 py-2" role="cell">
              {t(`frameMeld.enableDialog.strategyFast${frameRate}`)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-[10px] leading-relaxed text-cs2-text-muted">
        {t("frameMeld.enableDialog.strategyFootnote")}
      </p>
      <p className="mt-1.5 text-[10px] font-bold leading-relaxed text-cs2-accent">
        {t("frameMeld.enableDialog.strategyFastNote")}
      </p>
    </>
  );
}

function FrameMeldEnableDialogContent({ onConfirm, onCancel }) {
  const t = useT();
  const [remainingSeconds, setRemainingSeconds] = useState(CONFIRM_DELAY_SECONDS);
  const [strategyHovered, setStrategyHovered] = useState(false);
  const [strategyFocused, setStrategyFocused] = useState(false);
  const [strategyPlacement, setStrategyPlacement] = useState(null);
  const strategyButtonRef = useRef(null);
  const strategyVisible = strategyHovered || strategyFocused;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemainingSeconds((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!strategyVisible || typeof window === "undefined") return undefined;
    const updatePlacement = () => {
      const anchor = strategyButtonRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(620, Math.max(280, window.innerWidth - 32));
      const left = Math.min(
        Math.max(16, rect.left),
        Math.max(16, window.innerWidth - width - 16),
      );
      const showBelow = window.innerHeight - rect.bottom >= 330;
      setStrategyPlacement(showBelow
        ? { left, top: rect.bottom + 8, width }
        : { bottom: window.innerHeight - rect.top + 8, left, width });
    };
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [strategyVisible]);

  const confirmDisabled = remainingSeconds > 0;

  return (
    <Modal
      open
      onClose={onCancel}
      title={t("frameMeld.enableDialog.title")}
      icon={<AlertTriangle className="h-5 w-5 text-amber-400" aria-hidden="true" />}
      maxWidth="max-w-2xl"
      maxHeight="max-h-[88vh]"
      fillHeight={false}
      contentClassName="overflow-y-auto px-5 py-4"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-cs2-border px-4 py-2 text-xs font-bold text-cs2-text-secondary transition-colors hover:border-cs2-border-focus hover:bg-cs2-bg-hover"
          >
            {t("frameMeld.enableDialog.cancel")}
          </button>
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={() => {
              if (!confirmDisabled) onConfirm?.();
            }}
            className="rounded-lg bg-cs2-accent px-4 py-2 text-xs font-bold text-cs2-text-on-accent shadow-glow-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:shadow-none disabled:opacity-40"
          >
            <span aria-live="polite">
              {confirmDisabled
                ? t("frameMeld.enableDialog.confirmCountdown", { seconds: remainingSeconds })
                : t("frameMeld.enableDialog.confirm")}
            </span>
          </button>
        </div>
      }
    >
      <ol className="space-y-2.5 text-xs leading-relaxed text-cs2-text-secondary">
        <li className="flex gap-2">
          <span className="shrink-0 font-semibold text-cs2-text-primary">1.</span>
          <span>{t("frameMeld.enableDialog.item1")}</span>
        </li>
        <li className="flex gap-2">
          <span className="shrink-0 font-semibold text-cs2-text-primary">2.</span>
          <span>
            {t("frameMeld.enableDialog.item2Prefix")}
            <strong className="font-bold text-red-400">{t("frameMeld.enableDialog.item2Emphasis")}</strong>
          </span>
        </li>
        {[3, 4, 5, 6].map((number) => (
          <li key={number} className="flex gap-2">
            <span className="shrink-0 font-semibold text-cs2-text-primary">{number}.</span>
            <span>{t(`frameMeld.enableDialog.item${number}`)}</span>
          </li>
        ))}
        <li className="flex gap-2 font-bold text-red-400">
          <span className="shrink-0">7.</span>
          <span>{t("frameMeld.enableDialog.item7")}</span>
        </li>
        <li className="flex gap-2">
          <span className="shrink-0 font-semibold text-cs2-text-primary">8.</span>
          <span>{t("frameMeld.enableDialog.item8")}</span>
        </li>
      </ol>

      <div className="mt-4 flex justify-start">
        <button
          ref={strategyButtonRef}
          type="button"
          aria-describedby={strategyVisible ? STRATEGY_TOOLTIP_ID : undefined}
          onMouseEnter={() => setStrategyHovered(true)}
          onMouseLeave={() => setStrategyHovered(false)}
          onFocus={() => setStrategyFocused(true)}
          onBlur={() => setStrategyFocused(false)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-accent/35 bg-cs2-accent/10 px-3 py-2 text-[11px] font-bold text-cs2-accent transition-colors hover:border-cs2-accent/60 hover:bg-cs2-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/50"
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
          {t("frameMeld.enableDialog.strategyButton")}
        </button>
      </div>
      {strategyVisible && strategyPlacement && typeof document !== "undefined"
        ? createPortal(
          <div
            id={STRATEGY_TOOLTIP_ID}
            role="tooltip"
            style={strategyPlacement}
            className="pointer-events-none fixed z-[110] max-h-[70vh] overflow-y-auto rounded-xl border border-cs2-accent/35 bg-cs2-bg-card p-4 shadow-2xl"
          >
            <InterpolationStrategyDetails t={t} />
          </div>,
          document.body,
        )
        : null}

      <div className="mt-5 rounded-lg border border-red-500/25 bg-red-500/5 p-3.5">
        <p className="text-xs font-bold text-red-400">{t("frameMeld.enableDialog.benchmarkTitle")}</p>
        <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-cs2-text-muted">
          {BENCHMARK_KEYS.map((key) => (
            <li key={key}>• {t(key)}</li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

export default function FrameMeldEnableDialog({ open, onConfirm, onCancel }) {
  if (!open) return null;
  return <FrameMeldEnableDialogContent onConfirm={onConfirm} onCancel={onCancel} />;
}
