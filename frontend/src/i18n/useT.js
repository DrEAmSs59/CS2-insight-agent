import { useCallback } from "react";
import { useLocaleStore } from "./localeStore.js";
import { translate } from "./translate.js";

export { translate };

export function useT() {
  // 使用 effectiveLocale（实际语言代码 zh/en），而不是配置值（可能为 "auto"）
  const effectiveLocale = useLocaleStore((s) => s.effectiveLocale);
  return useCallback((key, params) => translate(effectiveLocale, key, params), [effectiveLocale]);
}
