export function isSmokeDebugEnabled({
  search = typeof window !== "undefined" ? window.location.search : "",
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  isDev = import.meta.env.DEV,
} = {}) {
  if (!isDev) return false;
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (q.get("smokeDebug") === "1") return true;
  try {
    return storage?.getItem("cs2.smokeDebug") === "1";
  } catch {
    return false;
  }
}
