import { isDesktopApp } from "../desktop/desktopBridge.js";
import { useDemoLoadingMessage } from "../hooks/useDemoLoadingMessage.js";

/**
 * Keeps the ornamental rotating line separate from factual backend progress.
 * The latter must remain visible so a playful status never hides real work.
 */
export default function DemoLoadingCopy({
  active = true,
  aiEnabled = false,
  desktop = isDesktopApp,
  detail = "",
  compact = false,
}) {
  const message = useDemoLoadingMessage({ active, aiEnabled, desktop });

  return (
    <div className={compact ? "min-w-0 max-w-[min(32rem,70vw)]" : "mt-1 flex flex-col items-center"}>
      <p
        key={message}
        data-testid="demo-loading-message"
        aria-live="polite"
        aria-atomic="true"
        className={`demo-loading-message break-words font-semibold text-cs2-text-primary ${compact ? "text-xs" : "text-sm"}`}
      >
        {message}
      </p>
      {detail && (
        <p
          data-testid="demo-loading-detail"
          className={`text-cs2-text-secondary ${compact ? "mt-0.5 text-[10px]" : "mt-1 max-w-2xl px-6 text-center text-xs leading-5"}`}
        >
          {detail}
        </p>
      )}
    </div>
  );
}
