import axios from "axios";
import { useLocaleStore } from "../i18n/localeStore.js";

// Tauri 开发模式仍使用 http://localhost，因此以注入的 IPC 对象判断桌面环境。
const IS_DESKTOP_APP = Boolean(window.__TAURI_INTERNALS__);

export const API_BASE_URL = IS_DESKTOP_APP ? "http://127.0.0.1:19871" : "";

/** 启动屏展示的连接目标（浏览器 dev 走 Vite 代理，桌面壳直连 19871）。 */
export const BACKEND_CONNECT_LABEL = IS_DESKTOP_APP
  ? "127.0.0.1:19871"
  : "127.0.0.1:8000 (Vite proxy)";

/** 桌面壳须用绝对 URL；浏览器 dev 用相对路径走 Vite 代理。 */
export function getDemosStreamUrl() {
  return API_BASE_URL ? `${API_BASE_URL}/api/demos/stream` : "/api/demos/stream";
}

/** Recorded clip HTTP Range stream for LiteCut / montage <video> preview */
export function getRecordedClipStreamUrl(clipId) {
  const id = encodeURIComponent(String(clipId));
  return API_BASE_URL
    ? `${API_BASE_URL}/api/recorded-clips/${id}/stream`
    : `/api/recorded-clips/${id}/stream`;
}

/** LiteCut uploaded overlay asset stream (WebM/PNG/GIF). */
export function getLiteCutAssetStreamUrl(assetId, previewVersion = "") {
  const id = encodeURIComponent(String(assetId));
  const base = API_BASE_URL
    ? `${API_BASE_URL}/api/lite-cut/assets/${id}/stream`
    : `/api/lite-cut/assets/${id}/stream`;
  return previewVersion ? `${base}?preview=${encodeURIComponent(String(previewVersion))}` : base;
}

export function getLiteCutBuiltinFontUrl(fontName) {
  const name = encodeURIComponent(String(fontName));
  return API_BASE_URL
    ? `${API_BASE_URL}/api/lite-cut/fonts/${name}`
    : `/api/lite-cut/fonts/${name}`;
}

console.log(`[API Init] Protocol: ${window.location.protocol}, IsDesktop: ${IS_DESKTOP_APP}, BaseURL: ${API_BASE_URL}`);

const API = axios.create({
  baseURL: `${API_BASE_URL}/api`,
});

API.interceptors.request.use((config) => {
  const locale = useLocaleStore.getState().locale || "zh";
  config.headers = config.headers ?? {};
  config.headers["X-CS2-Insight-Locale"] = locale;
  return config;
});

/** axios 尚未收到 HTTP 响应时的典型错误：安装版启动瞬间后端未监听会导致 ECONNREFUSED。 */
export function isTransientAxiosNetworkError(error) {
  if (error && error.response) return false;
  const c = error?.code;
  if (
    c === "ECONNREFUSED" ||
    c === "ECONNRESET" ||
    c === "ETIMEDOUT" ||
    c === "ECONNABORTED" ||
    c === "ERR_NETWORK"
  ) {
    return true;
  }
  const msg = String(error?.message || "");
  return msg.includes("Network Error");
}

export default API;
