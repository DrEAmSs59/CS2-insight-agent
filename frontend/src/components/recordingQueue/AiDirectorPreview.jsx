import { useEffect, useRef, useState } from "react";
import { Clapperboard, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useT } from "../../i18n/useT.js";
import { buildDtoFromQueueItem } from "../../recording/buildDtoFromQueueItem";
import { fetchAiDirectorPreview } from "../../recording/aiDirectorApi";

function blockBadge(type, t) {
  if (type === "killer_merged") return t("queue.aiDirectorBadgeMerged");
  if (type === "kill_with_victim") return t("queue.aiDirectorBadgeKv");
  return t("queue.aiDirectorBadgeSingle");
}

/**
 * @param {{
 *   item: import("../../stores/recordingQueueStore").RecordingQueueItem,
 *   globalPacing: Record<string, unknown>,
 * }} props
 */
export default function AiDirectorPreview({ item, globalPacing }) {
  const t = useT();
  const [state, setState] = useState({ status: "idle", data: null, error: null });
  const reqIdRef = useRef(0);

  const load = async () => {
    const dto = buildDtoFromQueueItem(item, item.matchMeta || null, globalPacing);
    if (!dto) {
      setState({ status: "error", data: null, error: t("queue.aiDirectorUnsupported") });
      return;
    }
    dto.options = { ...dto.options, use_ai_director: true, enable_victim_pov: true };

    const myId = ++reqIdRef.current;
    setState((s) => ({ ...s, status: "loading", error: null }));
    try {
      const data = await fetchAiDirectorPreview(dto);
      if (myId !== reqIdRef.current) return;
      setState({ status: "ok", data, error: null });
    } catch (e) {
      if (myId !== reqIdRef.current) return;
      const msg = e?.response?.data?.detail || e?.message || String(e);
      setState({ status: "error", data: null, error: msg });
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch when pacing / clip identity changes
  }, [item.id, item.pacing_override, globalPacing]);

  const { status, data, error } = state;

  return (
    <div className="rounded border border-violet-500/25 bg-violet-500/5 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-cs2-text-primary">
          <Sparkles className="h-3 w-3 shrink-0 text-violet-400" />
          {t("queue.aiDirectorPreviewTitle")}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={status === "loading"}
          className="flex items-center gap-1 rounded border border-cs2-border px-1.5 py-0.5 text-[9px] text-cs2-text-muted hover:text-cs2-text-secondary disabled:opacity-50"
          title={t("queue.aiDirectorRefresh")}
        >
          {status === "loading" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {t("queue.aiDirectorRefresh")}
        </button>
      </div>

      {status === "loading" && !data ? (
        <p className="flex items-center gap-1.5 text-[9px] text-cs2-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("queue.aiDirectorLoading")}
        </p>
      ) : null}

      {error ? (
        <p className="text-[9px] leading-relaxed text-red-400/90">{error}</p>
      ) : null}

      {data ? (
        <>
          <p className="text-[9px] leading-relaxed text-cs2-text-muted">
            {data.rationale || t("queue.aiDirectorNoRationale")}
          </p>
          <p className="mt-1 text-[9px] text-cs2-text-muted/80">
            {t("queue.aiDirectorMeta", {
              source: data.source === "llm" ? t("queue.aiDirectorSourceLlm") : t("queue.aiDirectorSourceHeuristic"),
              segments: data.estimated_segments,
              victims: data.victim_pov_count ?? data.victim_pov_blocks ?? 0,
              kills: data.kill_count,
            })}
          </p>
          {data.source !== "llm" && data.llm_error ? (
            <p className="mt-1 break-words text-[9px] leading-relaxed text-amber-400/95">
              {t("queue.aiDirectorLlmError", { error: data.llm_error })}
            </p>
          ) : data.source !== "llm" ? (
            <p className="mt-1 text-[9px] text-amber-400/90">{t("queue.aiDirectorHeuristicWarn")}</p>
          ) : null}
          {Array.isArray(data.victim_pov_omitted) && data.victim_pov_omitted.length > 0 ? (
            <div className="mt-2 rounded border border-amber-500/20 bg-amber-500/5 p-1.5">
              <p className="text-[9px] font-semibold text-amber-300/90">
                {t("queue.aiDirectorOmittedTitle")}
              </p>
              <ul className="mt-1 space-y-0.5 text-[9px] text-amber-200/80">
                {data.victim_pov_omitted.map((row) => (
                  <li key={row.index}>
                    {t("queue.aiDirectorOmittedRow", {
                      index: row.display_index ?? row.index + 1,
                      score: row.victim_pov_score,
                      victim: row.victim || "—",
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <ol className="mt-2 max-h-48 space-y-1 overflow-y-auto text-[9px] leading-snug text-cs2-text-secondary">
            {(data.blocks || []).map((block, i) => (
              <li key={`${block.type}-${i}`} className="flex gap-1.5">
                <span className="shrink-0 font-mono text-cs2-text-muted">{i + 1}.</span>
                <span>
                  <span className="mr-1 rounded border border-violet-500/30 bg-violet-500/10 px-1 py-px text-[8px] font-bold text-violet-300">
                    {blockBadge(block.type, t)}
                  </span>
                  {block.label ? <span className="text-cs2-text-primary">{block.label}</span> : null}
                  {block.type === "killer_merged" && block.kill_indices?.length ? (
                    <span className="ml-1 text-cs2-text-muted">
                      (#{block.kill_indices.map((x) => x + 1).join(", ")})
                    </span>
                  ) : null}
                  {block.kill_index != null && block.type !== "killer_merged" ? (
                    <span className="ml-1 text-cs2-text-muted">#{block.kill_index + 1}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-1.5 flex items-center gap-1 text-[9px] text-cs2-text-muted/80">
            <Clapperboard className="h-3 w-3" />
            {t("queue.planPreviewFootnote", { n: data.estimated_segments })}
          </p>
        </>
      ) : null}
    </div>
  );
}
