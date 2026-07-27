import { useEffect, useMemo, useState } from "react";

import { useT } from "../i18n/useT.js";
import {
  getDemoLoadingMessageKeys,
  pickNextDemoLoadingMessageKey,
} from "../utils/demoLoadingMessages.js";

const DEFAULT_ROTATION_INTERVAL_MS = 2400;

export function useDemoLoadingMessage({
  active = true,
  aiEnabled = false,
  desktop = false,
  intervalMs = DEFAULT_ROTATION_INTERVAL_MS,
} = {}) {
  const t = useT();
  const keys = useMemo(
    () => getDemoLoadingMessageKeys({ aiEnabled, desktop }),
    [aiEnabled, desktop],
  );
  const [messageKey, setMessageKey] = useState(() => pickNextDemoLoadingMessageKey(keys));

  useEffect(() => {
    if (!active) return undefined;

    setMessageKey((current) => pickNextDemoLoadingMessageKey(keys, current));
    const timer = window.setInterval(() => {
      setMessageKey((current) => pickNextDemoLoadingMessageKey(keys, current));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs, keys]);

  return messageKey ? t(messageKey) : "";
}
