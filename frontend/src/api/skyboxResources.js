import { useCallback, useEffect, useState } from "react";

import API from "./api";

export async function fetchSkyboxResources() {
  const { data } = await API.get("game-resources/skyboxes");
  return Array.isArray(data?.items) ? data.items : [];
}

export function useSkyboxResources(enabled = true) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(Boolean(enabled));
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!enabled) return [];
    setLoading(true);
    setError("");
    try {
      const next = await fetchSkyboxResources();
      setItems(next);
      return next;
    } catch (requestError) {
      setError(
        requestError?.response?.data?.detail
          || requestError?.message
          || "Failed to load skybox resources",
      );
      return [];
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { items, loading, error, refresh };
}
