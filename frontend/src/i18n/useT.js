import { useCallback } from "react";
import { useLocaleStore } from "./localeStore.js";
import zh from "./dict/zh.js";
import en from "./dict/en.js";

const DICTS = { zh, en };

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m,
  );
}

export function translate(locale, key, params) {
  const dict = DICTS[locale] || DICTS.zh;
  let value = dict[key];
  if (value === undefined) value = DICTS.zh[key]; // 回退到中文
  if (value === undefined) {
    if (import.meta.env?.DEV) {
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key; // 最终回退：原样返回 key
  }
  return interpolate(value, params);
}

export function useT() {
  const locale = useLocaleStore((s) => s.locale);
  return useCallback((key, params) => translate(locale, key, params), [locale]);
}
