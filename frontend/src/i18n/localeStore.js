import { create } from "zustand";
import API from "../api/api";

export const SUPPORTED_LOCALES = ["auto", "zh", "en"];
const DEFAULT_LOCALE = "auto";

// 解析 "auto" 为实际语言代码（zh/en）
function resolveEffectiveLocale(locale) {
  if (locale === "auto") {
    // 检测浏览器/操作系统语言
    const browserLang = navigator.language || navigator.userLanguage || "";
    return browserLang.toLowerCase().includes("zh") ? "zh" : "en";
  }
  return locale;
}

// 验证配置值是否合法（auto/zh/en）
function normalizeConfig(next) {
  return SUPPORTED_LOCALES.includes(next) ? next : DEFAULT_LOCALE;
}

// 验证实际语言代码是否合法（zh/en）
function normalizeEffective(next) {
  const resolved = resolveEffectiveLocale(next);
  return resolved === "zh" || resolved === "en" ? resolved : "zh";
}

export const useLocaleStore = create((set, get) => ({
  locale: DEFAULT_LOCALE, // 配置值（可能是 "auto"）
  effectiveLocale: normalizeEffective(DEFAULT_LOCALE), // 实际使用的语言（zh/en）

  // 从后端配置注入（GET /api/config 拉取后调用）：只更新内存，不回写后端
  hydrate: (next) => {
    const locale = normalizeConfig(next);
    const effectiveLocale = normalizeEffective(locale);
    set({ locale, effectiveLocale });
  },

  // 用户主动切换：立即更新 UI，并持久化到 cs2-insight.config.json（PUT /api/config）
  setLocale: (next) => {
    const locale = normalizeConfig(next);
    const effectiveLocale = normalizeEffective(locale);
    set({ locale, effectiveLocale });
    API.put("config", { locale }).catch((e) => {
      if (import.meta.env?.DEV) {
        console.warn("[i18n] persist locale failed:", e);
      }
    });
  },
}));
