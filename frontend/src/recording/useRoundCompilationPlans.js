import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import API from "../api/api";
import { buildRecordingQueueRequestsFromQueue } from "../utils/recordingBatch";
import { isFreezeToDeathCompilation } from "../utils/freezeToDeathRoundFilter";

export const RoundCompilationPlansContext = createContext({});
export const useRoundCompilationPlan = (item) => useContext(RoundCompilationPlansContext)[item?.id];

// UI-only previews, using the same DTO builder and backend planner as execution.
// No OBS, HLAE, native extension or Pro dependencies.
export function useRoundCompilationPlans(queue, globalPacing, uploadedDemos, parsedMatches, demoLibraryItems) {
  const [results, setResults] = useState({});
  const [revision, setRevision] = useState(0);
  const cache = useRef(new Map());
  const specs = useMemo(() => queue.filter((item) => isFreezeToDeathCompilation(item.clipData)).map((item) => {
    try {
      const [dto] = buildRecordingQueueRequestsFromQueue([item], globalPacing, uploadedDemos, parsedMatches, demoLibraryItems);
      dto.request_id = "round-preview";
      return { id: item.id, key: JSON.stringify(dto), dto };
    } catch (error) {
      return { id: item.id, errorKey: error.translationKey || "ftd.errorNoWindows" };
    }
  }), [queue, globalPacing, uploadedDemos, parsedMatches, demoLibraryItems]);
  const signature = JSON.stringify(specs);
  useEffect(() => {
    const controller = new AbortController();
    const current = JSON.parse(signature);
    let cursor = 0;
    async function worker() {
      while (cursor < current.length && !controller.signal.aborted) {
        const spec = current[cursor++];
        if (!spec.dto) continue;
        let result = cache.current.get(spec.key);
        if (!result) {
          try {
            const { data } = await API.post("/recording/plan", spec.dto, { signal: controller.signal, timeout: 15000 });
            if (!Array.isArray(data?.active_segments) || !Number.isFinite(data.estimated_duration_sec)) throw new Error("Invalid plan");
            result = { status: "ready", plan: data };
            cache.current.set(spec.key, result);
            if (cache.current.size > 64) cache.current.delete(cache.current.keys().next().value);
          } catch {
            result = { status: "error", errorKey: "ftd.planFailed" };
          }
        }
        if (!controller.signal.aborted) setResults((old) => ({ ...old, [spec.key]: result }));
      }
    }
    setResults({});
    for (let n = 0; n < Math.min(4, current.length); n++) void worker();
    return () => controller.abort();
  }, [signature, revision]);
  return Object.fromEntries(specs.map((spec) => [spec.id, spec.errorKey
    ? { status: "error", errorKey: spec.errorKey }
    : { ...(results[spec.key] || cache.current.get(spec.key) || { status: "loading" }), retry: () => setRevision((n) => n + 1) }]));
}
