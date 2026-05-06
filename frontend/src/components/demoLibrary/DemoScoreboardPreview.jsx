import axios from "axios";
import { memo, useEffect, useMemo, useState } from "react";
import DemoTeamMiniTable from "./DemoTeamMiniTable";
import {
  buildMiniScoreboardTeams,
  buildScoreboardHeader,
  scoreboardHasOptionalAdr,
  scoreboardHasOptionalRating,
} from "../../utils/demoScoreboardModel";

const API = axios.create({ baseURL: "/api" });

/**
 * @param {object} props
 * @param {Record<string, unknown>} props.demoItem
 * @param {string} props.highlightQuery
 */
function DemoScoreboardPreview({ demoItem, highlightQuery, steamHighlightQuery }) {
  const [rawPlayers, setRawPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const demoId = demoItem?.id;

  useEffect(() => {
    let cancelled = false;
    if (demoId == null) return undefined;

    setLoading(true);

    (async () => {
      try {
        const { data } = await API.get(`/demos/${demoId}/player-stats`);
        if (!cancelled) setRawPlayers(Array.isArray(data?.players) ? data.players : []);
      } catch {
        if (!cancelled) setRawPlayers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [demoId]);

  const header = useMemo(() => buildScoreboardHeader(demoItem), [demoItem]);

  const teams = useMemo(() => buildMiniScoreboardTeams(demoItem, rawPlayers), [demoItem, rawPlayers]);

  const focusPlayerName = useMemo(() => {
    const r = demoItem.result && typeof demoItem.result === "object" ? demoItem.result : null;
    const mm = r?.match_meta && typeof r.match_meta === "object" ? r.match_meta : {};
    const v = r?.auto_target_player ?? mm.target_player;
    return v ? String(v).trim() : "";
  }, [demoItem]);

  const allShown = useMemo(
    () => [...teams.left.players, ...teams.right.players],
    [teams.left.players, teams.right.players]
  );

  const showAdr = useMemo(() => scoreboardHasOptionalAdr(allShown), [allShown]);
  const showRating = useMemo(() => scoreboardHasOptionalRating(allShown), [allShown]);

  const hasRoster = teams.playersCount > 0 && !loading;

  return (
    <div className="border-l-2 border-cs2-orange/35 bg-[#0d0d10]/95 py-2 pl-3 pr-2 shadow-inner">
      <div className="flex max-h-[240px] min-h-[180px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/[0.06] pb-2 text-[10px] text-zinc-500">
          <span>
            <span className="text-zinc-600">地图</span>{" "}
            <span className="font-mono text-zinc-300">{header.map}</span>
          </span>
          <span>
            <span className="text-zinc-600">比分</span>{" "}
            <span className="font-mono font-semibold text-cs2-orange">{header.score}</span>
          </span>
          <span>
            <span className="text-zinc-600">回合</span>{" "}
            <span className="font-mono text-zinc-300">{header.rounds}</span>
          </span>
          <span>
            <span className="text-zinc-600">时长</span>{" "}
            <span className="font-mono text-zinc-300">{header.duration}</span>
          </span>
          <span>
            <span className="text-zinc-600">入库</span>{" "}
            <span className="font-mono text-zinc-300">{header.date}</span>
          </span>
          <span>
            <span className="text-zinc-600">状态</span>{" "}
            <span className="rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 font-semibold text-zinc-300">
              {header.statusLabel}
            </span>
          </span>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center py-6 text-[11px] text-zinc-500">加载比分板…</div>
        ) : null}

        {!loading && !hasRoster ? (
          <div className="flex flex-1 items-center justify-center py-6 text-center text-[11px] leading-relaxed text-zinc-500">
            暂无比分板数据，请先解析该 Demo
          </div>
        ) : null}

        {!loading && hasRoster ? (
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
            <DemoTeamMiniTable
              label={teams.left.label}
              score={teams.left.score}
              players={teams.left.players}
              showAdr={showAdr}
              showRating={showRating}
              highlightQuery={highlightQuery}
              steamHighlightQuery={steamHighlightQuery}
              focusPlayerName={focusPlayerName}
            />
            <DemoTeamMiniTable
              label={teams.right.label}
              score={teams.right.score}
              players={teams.right.players}
              showAdr={showAdr}
              showRating={showRating}
              highlightQuery={highlightQuery}
              steamHighlightQuery={steamHighlightQuery}
              focusPlayerName={focusPlayerName}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default memo(DemoScoreboardPreview);
