import { BACKEND_CONNECT_LABEL } from "../api/api.js";
import { useT } from "../i18n/useT.js";
import Cs2LoadingAnimation from "./Cs2LoadingAnimation.jsx";

export default function StartupLoadingOverlay({ phase }) {
  const t = useT();
  if (!phase) return null;
  const backend = phase === "backend";
  return (
    <div role="status" className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-cs2-bg-dark/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-6 rounded-2xl border border-cs2-border-subtle bg-cs2-bg-card p-8 shadow-2xl">
        <Cs2LoadingAnimation />
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-xl font-bold tracking-tight text-cs2-text-primary">{t(backend
            ? "app.backendConnecting" : phase === "config" ? "app.startupCheckingConfig" : "app.startupCheckingUpdate")}</h2>
          <p className="text-sm text-cs2-text-secondary">{t(backend ? "app.backendStarting" : "app.startupPleaseWait")}</p>
        </div>
        {backend && <div className="flex items-center gap-2 rounded-full border border-cs2-border bg-cs2-bg-input px-3 py-1.5">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-cs2-accent" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-cs2-text-secondary">Attempting to connect: {BACKEND_CONNECT_LABEL}</span>
        </div>}
      </div>
    </div>
  );
}
