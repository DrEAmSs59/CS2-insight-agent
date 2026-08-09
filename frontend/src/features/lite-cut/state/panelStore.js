import { create } from "zustand";

const STORAGE_KEY = "liteCut:panelLayout";

const DEFAULT = {
  mainContent: 58,
  timeline: 42,
  tools: 20,
  preview: 48,
  properties: 32,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT };
  }
}

export const useLiteCutPanelStore = create((set, get) => ({
  ...load(),
  setPanel: (panel, size) => {
    const next = { ...get(), [panel]: size };
    set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  },
}));
