import axios from "axios";

// 立即同步检测环境：如果当前是通过自定义协议加载的，则必须使用绝对路径请求后端
const IS_ELECTRON_APP = window.location.protocol === "app:";
export const API_BASE_URL = IS_ELECTRON_APP ? "http://127.0.0.1:19871" : "";

const API = axios.create({ 
  baseURL: `${API_BASE_URL}/api` 
});

export default API;
