import { create } from "zustand";

const STORAGE_KEY = "cs2-insight-locale";
export const SUPPORTED_LOCALES = ["zh", "en"];
const DEFAULT_LOCALE = "zh";

function readInitialLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED_LOCALES.includes(saved)) return saved;
  } catch {
    /* localStorage 不可用时静默回退 */
  }
  return DEFAULT_LOCALE;
}

export const useLocaleStore = create((set) => ({
  locale: readInitialLocale(),
  setLocale: (next) => {
    const locale = SUPPORTED_LOCALES.includes(next) ? next : DEFAULT_LOCALE;
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      /* ignore */
    }
    set({ locale });
  },
}));
