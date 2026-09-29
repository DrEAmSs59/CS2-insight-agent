import { useEffect, useState } from "react";
import API from "../api/api";

const RETRY_DELAYS_MS = [1000, 3000, 10000];

/** Load once per app session, independently of which page is mounted. */
export function useAppAnnouncements(backendReady) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!backendReady) return;
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer;

    async function load(attempt = 0) {
      try {
        const { data } = await API.get("/app/announcements", {
          signal: controller.signal,
          timeout: 5000,
        });
        if (!cancelled) setItems(Array.isArray(data?.announcements) ? data.announcements : []);
      } catch (error) {
        const status = error?.response?.status;
        if (!cancelled && (status == null || status >= 500) && attempt < RETRY_DELAYS_MS.length) {
          retryTimer = setTimeout(() => void load(attempt + 1), RETRY_DELAYS_MS[attempt]);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      controller.abort();
    };
  }, [backendReady]);

  return items;
}
