import { Clock, Calendar } from "lucide-react";
import RoundsStrip from "./RoundsStrip";
import DemoDownloadCell from "./DemoDownloadCell";

const RESULT_STYLE = {
  win:  { bar: "#2eb86a", badge: "bg-[#2eb86a]/15 text-[#2eb86a]", label: "胜" },
  loss: { bar: "#e0556a", badge: "bg-[#e0556a]/15 text-[#e0556a]", label: "负" },
  tie:  { bar: "#d97706", badge: "bg-[#d97706]/15 text-[#d97706]", label: "平" },
};

const MODE_LABEL = { premier: "优先排位", competitive: "竞技模式" };

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  return `${m} 分钟`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yy}/${mm}/${dd} ${hh}:${min}`;
}

function ratingColor(r) {
  if (r >= 1.2) return "#2eb86a";
  if (r < 0.95) return "#e0556a";
  return undefined;
}

function kdColor(k, d) {
  const kd = d > 0 ? k / d : k;
  if (kd >= 1.2) return "text-[#2eb86a]";
  if (kd < 0.95) return "text-[#e0556a]";
  return "text-cs2-text-primary";
}

export default function MatchHistoryRow({ match, onDownload, onGoToLibrary }) {
  const style = RESULT_STYLE[match.result] || RESULT_STYLE.tie;
  const demoFilename = `match730_${match.match_id}.dem`;
  const scoreColor = style.bar;

  return (
    <div
      className="grid items-center rounded-[10px] border border-cs2-border bg-cs2-bg-card overflow-hidden"
      style={{ gridTemplateColumns: "4px 116px 1fr 240px 200px 130px 120px" }}
    >
      {/* Col 1: result bar */}
      <div className="self-stretch" style={{ backgroundColor: style.bar }} />

      {/* Col 2: map */}
      <div className="flex flex-col items-center gap-1 p-2">
        <div className="flex h-14 w-[92px] items-center justify-center rounded-[5px] bg-cs2-bg-elevated text-[10px] text-cs2-text-muted">
          {match.map}
        </div>
        <div className="text-center text-[14.5px] font-semibold text-cs2-text-primary leading-none">
          {match.map.replace("de_", "")}
        </div>
        <div className="font-mono text-[11.5px] uppercase text-cs2-text-muted">
          {MODE_LABEL[match.mode] || match.mode}
        </div>
      </div>

      {/* Col 3: score + meta */}
      <div className="flex flex-col gap-1.5 px-3 py-3">
        <div className={`inline-flex w-fit items-center rounded-[4px] px-2 py-0.5 text-[12px] font-bold ${style.badge}`}>
          {style.label}
        </div>
        <div className="font-mono text-[17px] font-bold">
          <span style={{ color: scoreColor }}>{match.score_own}</span>
          <span className="mx-1 text-cs2-text-muted">:</span>
          <span className="text-cs2-text-primary">{match.score_opp}</span>
        </div>
        <div className="flex items-center gap-3 text-[11.5px] text-cs2-text-muted">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {fmtDuration(match.duration_sec)}
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {fmtDate(match.played_at)}
          </span>
        </div>
      </div>

      {/* Col 4: rounds strip */}
      <div className="px-3 py-3">
        <RoundsStrip rounds={match.rounds} />
      </div>

      {/* Col 5: personal stats */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-3">
        <div>
          <div className="text-[10.5px] text-cs2-text-muted">击杀·阵亡·助攻</div>
          <div className={`font-mono text-[13px] font-semibold ${kdColor(match.kills, match.deaths)}`}>
            {match.kills}–{match.deaths}–{match.assists}
          </div>
        </div>
        <div>
          <div className="text-[10.5px] text-cs2-text-muted">爆头率</div>
          <div className="font-mono text-[13px] font-semibold text-cs2-text-primary">{match.headshot_pct}%</div>
        </div>
        <div>
          <div className="text-[10.5px] text-cs2-text-muted">场均伤害</div>
          <div className="font-mono text-[13px] font-semibold text-cs2-text-primary">{match.adr}</div>
        </div>
        <div>
          <div className="text-[10.5px] text-cs2-text-muted">MVP</div>
          <div className="font-mono text-[13px] font-semibold text-cs2-text-primary">{match.mvp_count}</div>
        </div>
      </div>

      {/* Col 6: rating + badges */}
      <div className="flex flex-col items-center gap-1.5 px-2 py-3">
        <div className="text-[10.5px] text-cs2-text-muted">综合评分</div>
        <div className="font-mono text-[20px] font-bold" style={{ color: ratingColor(match.rating) }}>
          {match.rating}
        </div>
        <div className="flex flex-wrap justify-center gap-1">
          {match.ace_count > 0 && (
            <span className="rounded-[4px] bg-blue-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-blue-400">
              五杀×{match.ace_count}
            </span>
          )}
          {match.mvp_count >= 4 && (
            <span className="rounded-[4px] bg-[#2eb86a]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#2eb86a]">
              MVP×{match.mvp_count}
            </span>
          )}
        </div>
      </div>

      {/* Col 7: demo download */}
      <div className="flex items-center justify-center px-2 py-3">
        <DemoDownloadCell
          matchId={match.match_id}
          demoUrl={match.demo_url}
          demoExpired={match.demo_expired}
          demoInLibrary={match.demo_in_library}
          demoExpiresAt={match.demo_expires_at}
          filename={demoFilename}
          onDownload={onDownload}
          onGoToLibrary={() => onGoToLibrary(match.match_id)}
        />
      </div>
    </div>
  );
}
