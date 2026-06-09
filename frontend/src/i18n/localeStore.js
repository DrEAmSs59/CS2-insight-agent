import { create } from "zustand";
import API from "../api/api";

export const SUPPORTED_LOCALES = ["zh", "en"];
const DEFAULT_LOCALE = "zh";

function normalize(next) {
  return SUPPORTED_LOCALES.includes(next) ? next : DEFAULT_LOCALE;
}

export const useLocaleStore = create((set) => ({
  locale: DEFAULT_LOCALE,

  // 从后端配置注入（GET /api/config 拉取后调用）：只更新内存，不回写后端。
  hydrate: (next) => set({ locale: normalize(next) }),

  // 用户主动切换：立即更新 UI，并持久化到 cs2-insight.config.json（PUT /api/config）。
  setLocale: (next) => {
    const locale = normalize(next);
    set({ locale });
    API.put("config", { locale }).catch((e) => {
      if (import.meta.env?.DEV) {
        console.warn("[i18n] persist locale failed:", e);
      }
    });
  },
}));
