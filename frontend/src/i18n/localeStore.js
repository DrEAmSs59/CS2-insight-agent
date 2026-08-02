import { create } from "zustand";
import API from "../api/api";

export const SUPPORTED_LOCALES = ["auto", "zh", "en"];
const DEFAULT_LOCALE = "auto";
const LOCALE_CACHE_KEY = "cs2-insight.locale";

function readCachedLocale() {
  try {
    return localStorage.getItem(LOCALE_CACHE_KEY);
  } catch {
    return null;
  }
}

function cacheLocale(locale) {
  try {
    localStorage.setItem(LOCALE_CACHE_KEY, locale);
  } catch {
    // The backend config remains authoritative when storage is unavailable.
  }
}

function syncDocumentLanguage(effectiveLocale) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = effectiveLocale === "zh" ? "zh-CN" : "en";
  }
}

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

const initialLocale = normalizeConfig(readCachedLocale());
const initialEffectiveLocale = normalizeEffective(initialLocale);
syncDocumentLanguage(initialEffectiveLocale);

export const useLocaleStore = create((set, get) => ({
  locale: initialLocale, // 配置值（可能是 "auto"）
  effectiveLocale: initialEffectiveLocale, // 实际使用的语言（zh/en）
  hydrated: false,
  persistenceError: null,

  // 从后端配置注入（GET /api/config 拉取后调用）：只更新内存，不回写后端
  hydrate: (next) => {
    const locale = normalizeConfig(next);
    const effectiveLocale = normalizeEffective(locale);
    cacheLocale(locale);
    syncDocumentLanguage(effectiveLocale);
    set({ locale, effectiveLocale, hydrated: true, persistenceError: null });
  },

  // 用户主动切换：立即更新 UI，并持久化到 cs2-insight.config.json（PUT /api/config）
  setLocale: async (next) => {
    const previous = {
      locale: get().locale,
      effectiveLocale: get().effectiveLocale,
    };
    const locale = normalizeConfig(next);
    const effectiveLocale = normalizeEffective(locale);
    cacheLocale(locale);
    syncDocumentLanguage(effectiveLocale);
    set({ locale, effectiveLocale, persistenceError: null });
    try {
      await API.put("config", { locale });
      return locale;
    } catch (error) {
      cacheLocale(previous.locale);
      syncDocumentLanguage(previous.effectiveLocale);
      set({ ...previous, persistenceError: error });
      if (import.meta.env?.DEV) {
        console.warn("[i18n] persist locale failed:", error);
      }
      throw error;
    }
  },
}));
