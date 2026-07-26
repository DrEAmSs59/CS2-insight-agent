import { useState, useEffect, useCallback } from "react";

const PREFIX = "cs2-session-";

/**
 * useState + sessionStorage 持久化。
 * 页面刷新后自动恢复上次会话状态。
 * @template T
 * @param {string} key sessionStorage key
 * @param {T | (() => T)} initialValue
 * @param {{ storageTransform?: (value: T) => unknown }} [options]
 */
export default function useSessionState(key, initialValue, { storageTransform } = {}) {
  const storageKey = PREFIX + key;

  const readValue = useCallback(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw !== null) return JSON.parse(raw);
    } catch { /* ignore */ }
    return typeof initialValue === "function" ? initialValue() : initialValue;
  }, [initialValue, storageKey]);

  const [entry, setEntry] = useState(() => ({
    storageKey,
    value: readValue(),
  }));
  const state = entry.storageKey === storageKey ? entry.value : readValue();

  useEffect(() => {
    if (entry.storageKey === storageKey) return;
    setEntry({ storageKey, value: readValue() });
  }, [entry.storageKey, readValue, storageKey]);

  useEffect(() => {
    if (entry.storageKey !== storageKey) return;
    try {
      if (state === null || state === undefined) {
        sessionStorage.removeItem(storageKey);
      } else {
        const value = storageTransform ? storageTransform(state) : state;
        sessionStorage.setItem(storageKey, JSON.stringify(value));
      }
    } catch { /* quota exceeded, ignore */ }
  }, [entry.storageKey, storageKey, state, storageTransform]);

  const setState = useCallback((next) => {
    setEntry((current) => {
      const currentValue = current.storageKey === storageKey ? current.value : readValue();
      return {
        storageKey,
        value: typeof next === "function" ? next(currentValue) : next,
      };
    });
  }, [readValue, storageKey]);

  const reset = useCallback(() => {
    try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ }
    setEntry({
      storageKey,
      value: typeof initialValue === "function" ? initialValue() : initialValue,
    });
  }, [storageKey, initialValue]);

  return [state, setState, reset];
}
