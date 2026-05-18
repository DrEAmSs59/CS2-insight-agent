import axios from "axios";

// 同步检测环境：
// 1. 检查协议是否为自定义的 app:
// 2. 检查 User Agent 是否包含 Electron (兜底方案)
const IS_ELECTRON_APP = 
  window.location.protocol === "app:" || 
  navigator.userAgent.toLowerCase().includes("electron");

export const API_BASE_URL = IS_ELECTRON_APP ? "http://127.0.0.1:19871" : "";

/** Electron 下须用绝对 URL；浏览器 dev 用相对路径走 Vite 代理 */
export function getDemosStreamUrl() {
  return API_BASE_URL ? `${API_BASE_URL}/api/demos/stream` : "/api/demos/stream";
}

console.log(`[API Init] Protocol: ${window.location.protocol}, IsElectron: ${IS_ELECTRON_APP}, BaseURL: ${API_BASE_URL}`);

const API = axios.create({ 
  baseURL: `${API_BASE_URL}/api` 
});

export default API;
