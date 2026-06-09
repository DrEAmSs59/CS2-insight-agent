import API from "../../api/api";
import { memo, useEffect, useMemo, useState } from "react";
import DemoTeamMiniTable from "./DemoTeamMiniTable";
import {
  buildMiniScoreboardTeams,
  buildScoreboardHeader,
  scoreboardHasOptionalAdr,
  scoreboardHasOptionalRating,
} from "../../utils/demoScoreboardModel";
import { useT } from "../../i18n/useT.js";

/**
 * @param {object} props
 * @param {Record<string, unknown>} props.demoItem
 * @param {string} props.highlightQuery
 */
function DemoScoreboardPreview({ demoItem, highlightQuery, steamHighlightQuery }) {
  const t = useT();
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

  const header = useMemo(() => buildScoreboardHeader(demoItem, t("library.durationUnit")), [demoItem, t]);

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
    <div className="border-l-2 border-cs2-accent/35 bg-cs2-bg-page/95 py-2 pl-3 pr-2 shadow-inner">
      <div className="flex max-h-[240px] min-h-[180px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-cs2-border pb-2 text-[11px] text-cs2-text-muted">
          <span>
            <span className="text-cs2-text-muted">{t("library.scoreboardMap")}</span>{" "}
            <span className="font-mono text-cs2-text-secondary">{header.map}</span>
          </span>
          <span>
            <span className="text-cs2-text-muted">{t("library.scoreboardScore")}</span>{" "}
            <span className="font-mono font-semibold text-cs2-accent">{header.score}</span>
          </span>
          <span>
            <span className="text-cs2-text-muted">{t("library.scoreboardRounds")}</span>{" "}
            <span className="font-mono text-cs2-text-secondary">{header.rounds}</span>
          </span>
          <span>
            <span className="text-cs2-text-muted">{t("library.scoreboardDuration")}</span>{" "}
            <span className="font-mono text-cs2-text-secondary">{header.duration}</span>
          </span>
          <span>
            <span className="text-cs2-text-muted">{t("library.scoreboardDate")}</span>{" "}
            <span className="font-mono text-cs2-text-secondary">{header.date}</span>
          </span>
          <span>
            <span className="text-cs2-text-muted">{t("library.scoreboardStatus")}</span>{" "}
            <span className="rounded border border-cs2-border bg-cs2-bg-hover px-1 py-0.5 font-semibold text-cs2-text-secondary">
              {t(header.statusLabelKey, header.statusLabelParams)}
            </span>
          </span>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center py-6 text-[12px] text-cs2-text-muted">{t("library.scoreboardLoading")}</div>
        ) : null}

        {!loading && !hasRoster ? (
          <div className="flex flex-1 items-center justify-center py-6 text-center text-[12px] leading-relaxed text-cs2-text-muted">
            {t("library.scoreboardNoData")}
          </div>
        ) : null}

        {!loading && hasRoster ? (
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
            <DemoTeamMiniTable
              label={teams.left.labelKey ? t(teams.left.labelKey) : "—"}
              score={teams.left.score}
              players={teams.left.players}
              showAdr={showAdr}
              showRating={showRating}
              highlightQuery={highlightQuery}
              steamHighlightQuery={steamHighlightQuery}
              focusPlayerName={focusPlayerName}
            />
            <DemoTeamMiniTable
              label={teams.right.labelKey ? t(teams.right.labelKey) : "—"}
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
