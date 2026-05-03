import { useEffect, useState } from "react";
import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";

const TYPE_CONFIG = {
  success: { icon: CheckCircle2, color: "text-emerald-400", border: "border-emerald-500/30" },
  error: { icon: AlertCircle, color: "text-rose-400", border: "border-rose-500/30" },
  info: { icon: Info, color: "text-sky-400", border: "border-sky-500/30" },
};

function ToastItem({ toast, onDismiss }) {
  const [exiting, setExiting] = useState(false);
  const config = TYPE_CONFIG[toast.type] || TYPE_CONFIG.info;
  const Icon = config.icon;

  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => setExiting(true), toast.duration - 300);
    return () => clearTimeout(timer);
  }, [toast.duration]);

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => onDismiss(toast.id), 300);
    return () => clearTimeout(timer);
  }, [exiting, toast.id, onDismiss]);

  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border ${config.border} bg-cs2-bg-card px-3.5 py-2.5 shadow-lg transition-all duration-300 ${
        exiting ? "translate-x-full opacity-0" : "translate-x-0 opacity-100"
      }`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${config.color}`} />
      <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-200">{toast.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
