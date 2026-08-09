import { useEffect, useRef, useState } from "react";
import { Info, Lock, Unlock } from "lucide-react";

import { useT } from "../../i18n/useT.js";

export default function ObsHostField({ value, onChange }) {
  const t = useT();
  const [unlocked, setUnlocked] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (unlocked) inputRef.current?.focus();
  }, [unlocked]);

  const toggleLabel = unlocked
    ? t("settings.obsHostLock")
    : t("settings.obsHostUnlock");

  return (
    <div>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value ?? "localhost"}
          readOnly={!unlocked}
          aria-label={t("settings.labelObsHost")}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && unlocked) setUnlocked(false);
          }}
          spellCheck={false}
          className={`w-full rounded-md border bg-cs2-bg-input py-2 pl-3 pr-11 text-xs text-cs2-text-primary placeholder:text-cs2-text-muted focus-visible:outline-none ${
            unlocked
              ? "border-cs2-accent focus-visible:border-cs2-accent"
              : "cursor-default border-cs2-border text-cs2-text-secondary"
          }`}
        />
        <button
          type="button"
          onClick={() => setUnlocked((current) => !current)}
          aria-label={toggleLabel}
          aria-pressed={unlocked}
          title={toggleLabel}
          className={`absolute right-1 top-1 inline-flex h-7 w-8 items-center justify-center rounded transition-colors ${
            unlocked
              ? "bg-cs2-accent/15 text-cs2-accent hover:bg-cs2-accent/25"
              : "text-cs2-text-muted hover:bg-cs2-surface-2 hover:text-cs2-text-primary"
          }`}
        >
          {unlocked ? <Unlock className="h-3.5 w-3.5" aria-hidden /> : <Lock className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </div>
      <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-cs2-text-muted">
        <Info className="mt-0.5 h-3 w-3 shrink-0 text-cs2-amber-on-surface" aria-hidden />
        <span>{t("settings.obsHostChangeHint")}</span>
      </p>
    </div>
  );
}
