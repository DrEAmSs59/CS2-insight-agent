import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { useT } from "../i18n/useT.js";
import Modal from "./ui/Modal.jsx";

const CONFIRM_DELAY_SECONDS = 3;
const BENCHMARK_KEYS = [
  "frameMeld.enableDialog.benchmark5070Ti",
  "frameMeld.enableDialog.benchmark5070",
  "frameMeld.enableDialog.benchmark6600Xt",
  "frameMeld.enableDialog.benchmark9070Xt",
];

function FrameMeldEnableDialogContent({ onConfirm, onCancel }) {
  const t = useT();
  const [remainingSeconds, setRemainingSeconds] = useState(CONFIRM_DELAY_SECONDS);

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
