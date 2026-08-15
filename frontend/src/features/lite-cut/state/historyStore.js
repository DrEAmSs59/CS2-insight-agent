import { create } from "zustand";

const MAX_HISTORY = 50;

export const useLiteCutHistoryStore = create((set, get) => ({
  past: [],
  future: [],

  push: (bodySnapshot) => {
    if (!bodySnapshot) return;
    set((s) => ({
      past: [...s.past.slice(-(MAX_HISTORY - 1)), structuredClone(bodySnapshot)],
      future: [],
    }));
  },

  clear: () => set({ past: [], future: [] }),

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  undo: (currentBody) => {
    const { past, future } = get();
    if (!past.length) return null;
    const prev = past[past.length - 1];
    set({
      past: past.slice(0, -1),
      future: currentBody ? [structuredClone(currentBody), ...future] : future,
    });
    return structuredClone(prev);
  },

  redo: (currentBody) => {
    const { past, future } = get();
    if (!future.length) return null;
    const next = future[0];
    set({
      past: currentBody ? [...past, structuredClone(currentBody)] : past,
      future: future.slice(1),
    });
    return structuredClone(next);
  },
}));
