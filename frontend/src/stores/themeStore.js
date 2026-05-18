import { create } from "zustand";

const STORAGE_KEY = "cs2-insight-theme";

function readInitial() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* ignore */ }
  return "dark";
}

export const useThemeStore = create((set) => ({
  theme: readInitial(),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
      return { theme: next };
    }),
}));
